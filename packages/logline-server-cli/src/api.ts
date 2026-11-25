import { isRecord, visible } from './output.js';

export const explorerPrefix = '/api/v1/explorer/';

export interface Request {
  /** Explorer route, with an optional query string. */
  path: string;
  method: 'GET' | 'POST';
  body?: Record<string, unknown>;
}

/** Resolve a deployment root (including its reverse-proxy prefix) and send a bounded Explorer request. */
export async function queryExplorer(base: string, token: string, request: Request): Promise<Buffer> {
  const url = URL.canParse(base) ? new URL(base) : undefined;
  if (
    !url ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  ) {
    throw new Error(
      'Use an HTTPS deployment URL without credentials, a query, or a fragment. HTTP is supported on loopback.',
    );
  }
  const target = new URL(url.pathname.replace(/\/+$/, '') + explorerPrefix + request.path, url.origin);
  const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: 'application/json' });
  if (request.body !== undefined) headers.set('Content-Type', 'application/json');

  let response: Response;
  let bytes: Buffer;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new Error('Could not read the Logline response. Check the deployment URL, connection, and server status.');
  }
  if (!response.ok) {
    const payload: unknown = parseResponse(bytes.toString('utf8'));
    const detail = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    const serverMessage = [detail?.code, detail?.message]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    const message = visible(serverMessage.replaceAll(token, '[redacted]')).slice(0, 500);
    throw new Error(`Logline API returned HTTP ${response.status}${message ? `  ${message}` : ''}`);
  }
  return bytes;
}

/** Decode a response without assuming its schema. */
export function parseResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
