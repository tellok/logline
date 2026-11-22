import { httpError } from './auth.mjs';

/** Browser ingest accepts any origin unless LOGLINE_INGEST_ORIGINS lists exact allowed origins. Never trust forwarded hosts, origin patterns, cookies, or client-supplied identity. */
export function ingestOrigins(setting = '') {
  const origins = new Set();
  if (setting === '') return origins;
  for (const entry of setting.split(',')) {
    const origin = entry.trim();
    const url = URL.parse(origin);
    if (!url || !['https:', 'http:'].includes(url.protocol) || origin !== url.origin || origin.includes('*'))
      throw Error('LOGLINE_INGEST_ORIGINS requires exact, comma-separated HTTP(S) origins');
    origins.add(origin);
  }
  return origins;
}

/**
 * Resolve CORS handling for the ingestion endpoint. Only call on that endpoint. An allowed origin
 * is a browser policy, not an authentication credential. An empty allowlist accepts every origin;
 * a nonempty allowlist restricts browser requests to the exact listed origins.
 */
export function ingestOriginHeaders(req, allowed) {
  const origin = req.headers.origin;
  if (origin === undefined && req.method !== 'OPTIONS') return {};
  if (allowed.size !== 0 && !allowed.has(origin))
    throw httpError(403, 'origin', 'Browser origin not allowed for ingestion.');
  const headers = origin === undefined ? { vary: 'Origin' } : { 'access-control-allow-origin': origin, vary: 'Origin' };
  if (req.method !== 'OPTIONS') return { ...headers, 'access-control-expose-headers': 'Retry-After' };
  const requested = (req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',');
  if (
    req.headers['access-control-request-method'] !== 'POST' ||
    requested.some((name) => !['', 'authorization', 'content-type'].includes(name.trim()))
  )
    throw httpError(403, 'preflight', 'Unsupported browser upload method or headers.');
  return {
    ...headers,
    vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'Authorization, Content-Type',
  };
}
