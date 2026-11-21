import {
  createReportingLoggingPlugin,
  type ReportingOptions,
  type ReportingTransport,
  type ReportingSendResult,
} from 'logline/plugin/reporting';

/** Address and credentials for exactly one destination. No hosted service is assumed. */
export interface LoglineServerOptions {
  /** Project ingestion DSN: https://<project-key>@host[/prefix]/<project-uuid>. */
  readonly dsn: string;
  /** Optional fetch-compatible client, for example in a non-browser runtime. */
  readonly fetch?: typeof fetch;
}

/** Parse the raw DSN before URL normalization; never include credentials or parser diagnostics in errors. */
function destination(dsn: string) {
  const invalid = () => new TypeError('Expected a project ingestion DSN (HTTPS, or HTTP on loopback)');
  if (typeof dsn !== 'string' || /[\s\\?#]/.test(dsn) || !/^https?:\/\/llpk_[A-Za-z0-9_-]{43}@[^/@]+\//i.test(dsn))
    throw invalid();
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    throw invalid();
  }
  const key = url.username;
  const projectId = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  const loopback =
    ['localhost', '[::1]'].includes(url.hostname) ||
    (/^127\./.test(url.hostname) && /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname));
  if (
    !/^llpk_[A-Za-z0-9_-]{43}$/.test(key) ||
    url.password ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(projectId)
  )
    throw invalid();
  url.username = '';
  url.pathname = url.pathname.slice(0, -projectId.length) + 'api/v1/logs';
  // Refuse a misconfigured DSN that repeats the credential in the hostname or proxy prefix.
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.href);
  } catch {
    throw invalid();
  }
  if (decoded.toLowerCase().includes(key.toLowerCase())) throw invalid();
  return { endpoint: url.href, projectId, key };
}

function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string');
const record = (input: unknown): input is Record<string, unknown> => typeof input === 'object' && input !== null;

/** Bound the decoded response even if a proxy strips Content-Length or returns an error page. */
async function acknowledgement(response: Response): Promise<ReportingSendResult> {
  if (!response.body) throw new Error('Missing ingestion acknowledgement');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new Error('Ingestion acknowledgement exceeds 1 MiB');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const result: unknown = JSON.parse(text + decoder.decode());
  if (
    !record(result) ||
    !ids(result.acceptedEventIds) ||
    !ids(result.retryableEventIds) ||
    !ids(result.rejectedEventIds) ||
    (result.retryAfterMs !== undefined &&
      (typeof result.retryAfterMs !== 'number' || !Number.isFinite(result.retryAfterMs) || result.retryAfterMs < 0))
  )
    throw new Error('Invalid ingestion acknowledgement');
  return {
    acceptedEventIds: result.acceptedEventIds,
    retryableEventIds: result.retryableEventIds,
    rejectedEventIds: result.rejectedEventIds,
    retryAfterMs: result.retryAfterMs,
  };
}

/** Create a one-attempt HTTP transport. The reporting plugin owns all buffering, retries and timeouts. */
export function createLoglineServerTransport(options: LoglineServerOptions): ReportingTransport {
  const { endpoint, projectId, key } = destination(options.dsn);
  const request = options.fetch ?? globalThis.fetch;
  if (typeof request !== 'function') throw new TypeError('Expected a fetch implementation');
  return {
    name: 'logline-server',
    async send(batch, { signal }) {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await request(endpoint, {
          method: 'POST',
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ projectId, events: batch }),
        });
      } catch {
        // A custom fetch implementation may include its request headers in the error.
        signal.throwIfAborted();
        throw new Error('Ingestion request failed');
      }
      const delay = retryAfter(response.headers.get('Retry-After'));
      // Quota exhaustion can acknowledge already committed IDs while deferring only new ones.
      if (response.ok || response.status === 429) {
        try {
          const result = await acknowledgement(response);
          return { ...result, retryAfterMs: Math.max(delay ?? 0, result.retryAfterMs ?? 0) };
        } catch {
          signal.throwIfAborted();
          if (response.ok) throw new Error('Invalid ingestion acknowledgement');
          // A generic gateway 429 may have an HTML or empty response rather than a partition.
        }
      } else {
        // Ignore cleanup failures; a stream cancellation error can contain the upstream response body.
        await response.body?.cancel().catch(() => undefined);
      }
      const transient = response.status >= 500 || [408, 425, 429].includes(response.status);
      const eventIds = batch.map((event) => event.id);
      return {
        acceptedEventIds: [],
        retryableEventIds: transient ? eventIds : [],
        rejectedEventIds: transient ? [] : eventIds,
        retryAfterMs: delay,
      };
    },
  };
}

/** Installable, independently managed destination; no request is made by construction or import. */
export function createLoglineServerReporter({
  reporting,
  ...destination
}: LoglineServerOptions & { readonly reporting?: Omit<ReportingOptions, 'transport'> }): ReturnType<
  typeof createReportingLoggingPlugin
> {
  return createReportingLoggingPlugin({ ...reporting, transport: createLoglineServerTransport(destination) });
}
