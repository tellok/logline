import {
  createReportingLoggingPlugin,
  type ReportingOptions,
  type ReportingTransport,
  type ReportingSendResult,
} from 'logline/plugin/reporting';

/** Address and credentials for exactly one destination. No hosted service is assumed. */
export interface LoglineServerOptions {
  /** Deployment root, optionally including a reverse-proxy path prefix. */
  readonly baseUrl: string | URL;
  /** Immutable server-issued project ID, not the project's slug or display name. */
  readonly projectId: string;
  readonly service: string;
  /** User-owned logs:write PAT, or a provider evaluated for each batch to support rotation. */
  readonly token: string | (() => string | Promise<string>);
  /** Optional fetch-compatible client, for example in a non-browser runtime. */
  readonly fetch?: typeof fetch;
}

function validToken(token: string): string {
  if (typeof token !== 'string' || !/^[!-~]+$/.test(token)) throw new TypeError('Expected a non-empty bearer token');
  return token;
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
  const base = new URL(options.baseUrl);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
  if (
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new TypeError('Expected a clean HTTPS deployment URL (HTTP allowed on loopback)');
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/api/v1/logs`;
  const { projectId, service, token, fetch: request = globalThis.fetch } = options;
  if (typeof projectId !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(projectId))
    throw new TypeError('Expected a server-issued project UUID');
  if (
    typeof service !== 'string' ||
    !service.trim() ||
    service.includes('\0') ||
    new TextEncoder().encode(service).length > 128 ||
    typeof request !== 'function'
  )
    throw new TypeError('Expected a service name (1–128 UTF-8 bytes) and fetch');
  if (typeof token !== 'function') validToken(token);
  return {
    name: 'logline-server',
    async send(batch, { signal }) {
      const credential = validToken(typeof token === 'function' ? await token() : token);
      signal.throwIfAborted();
      const response = await request(base.href, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: JSON.stringify({ projectId, service, events: batch }),
      });
      const delay = retryAfter(response.headers.get('Retry-After'));
      // Quota exhaustion can acknowledge already committed IDs while deferring only new ones.
      if (response.ok || response.status === 429) {
        try {
          const result = await acknowledgement(response);
          return { ...result, retryAfterMs: Math.max(delay ?? 0, result.retryAfterMs ?? 0) };
        } catch (error) {
          if (response.ok || signal.aborted) throw error;
          // A generic gateway 429 may have an HTML or empty response rather than a partition.
        }
      } else await response.body?.cancel();
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
