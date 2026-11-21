import { createServer } from 'node:http';
import { ingestOrigins, ingestOriginHeaders } from './ingest-origin.mjs';
import { bearer, requireAdmin, validProjectKey } from './auth.mjs';
import { pathToFileURL } from 'node:url';
import { createPool, migrate, prune } from './db.mjs';
import { envelope, fault, ingest } from './ingest.mjs';
import { handleAdmin } from './admin.mjs';
import { handleExplorer } from './explorer.mjs';
import { handleMcp } from './mcp.mjs';

/** Read validated startup configuration; never fall back to a development credential. */
export function configuration(env) {
  const integer = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`Invalid ${key}`);
    return value;
  };
  if (!env.DATABASE_URL || !['postgresql:', 'postgres:'].includes(new URL(env.DATABASE_URL).protocol))
    throw Error('DATABASE_URL is required');
  if (
    !env.LOGLINE_ADMIN_TOKEN ||
    Buffer.byteLength(env.LOGLINE_ADMIN_TOKEN) < 32 ||
    /^(?:llpat|llpk)_/.test(env.LOGLINE_ADMIN_TOKEN) ||
    env.LOGLINE_ADMIN_TOKEN.includes(',') ||
    !/^[!-~]+$/.test(env.LOGLINE_ADMIN_TOKEN)
  )
    throw Error('LOGLINE_ADMIN_TOKEN requires at least 32 printable non-space ASCII bytes');
  if (!['true', 'false'].includes(env.LOGLINE_MCP_ENABLED ?? 'true')) throw Error('Invalid LOGLINE_MCP_ENABLED');
  return {
    url: env.DATABASE_URL,
    origins: ingestOrigins(env.LOGLINE_INGEST_ORIGINS),
    adminToken: env.LOGLINE_ADMIN_TOKEN,
    mcp: env.LOGLINE_MCP_ENABLED !== 'false',
    port: integer('PORT', 4318, 0, 65535),
    host: env.HOST ?? '0.0.0.0',
    projectEvents: integer('PROJECT_EVENTS_PER_MINUTE', 60000, 1, 1000000000),
    projectBytes: integer('PROJECT_BYTES_PER_MINUTE', 67108864, 1, 1000000000000),
    ingestMax: integer('INGEST_CONCURRENCY', 12, 1, 128),
    queryMax: integer('QUERY_CONCURRENCY', 4, 1, 128),
    days: integer('RETENTION_DAYS', 30, 1, 3650),
    maxEvents: integer('MAX_BATCH_EVENTS', 500, 1, 5000),
    maxBytes: integer('MAX_BODY_BYTES', 1048576, 1024, 8388608),
  };
}

/** Bound streaming and declared bodies alike. A short absolute deadline includes slow uploads. */
async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw fault(413, 'body_limit', 'Request body too large.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')
    throw fault(415, 'encoding', 'Compressed input is not supported.');
  if (!req.headers['transfer-encoding'] && !Number(req.headers['content-length'])) return undefined;
  if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json')
    throw fault(415, 'content_type', 'Expected application/json.');
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const finish = (error) => {
      clearTimeout(timer);
      req.off('data', data);
      req.off('aborted', aborted);
      req.off('end', end);
      req.off('error', failed);
      if (error) {
        req.pause();
        reject(error);
      } else resolve(Buffer.concat(chunks, bytes));
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) finish(fault(413, 'body_limit', 'Request body too large.'));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const aborted = () => finish(fault(400, 'aborted', 'Request aborted.'));
    const failed = () => aborted();
    const timer = setTimeout(() => finish(fault(408, 'timeout', 'Upload deadline exceeded.')), 10000);
    req.on('data', data).once('aborted', aborted).once('end', end).once('error', failed);
  });
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw fault(400, 'invalid_json', 'Invalid UTF-8 JSON.');
  }
}

const buckets = [0.005, 0.025, 0.1, 0.25, 1, 3, 10, Infinity];
const histogram = () => ({ count: 0, sum: 0, bins: buckets.map(() => 0) });
function observe(h, sec) {
  h.count++;
  h.sum += sec;
  buckets.forEach((b, i) => {
    if (sec <= b) h.bins[i]++;
  });
}
function metrics(c, active, hist) {
  const lines = Object.entries(c).map(([k, v]) => `logline_${k}_total ${v}`);
  lines.push(
    `logline_ingest_in_flight ${active.ingest}`,
    `logline_query_in_flight ${active.query}`,
    'logline_ingest_backlog 0',
  );
  for (const [route, h] of Object.entries(hist)) {
    const name = 'logline_request_duration_seconds';
    buckets.forEach((b, i) =>
      lines.push(`${name}_bucket{route="${route}",le="${Number.isFinite(b) ? b : '+Inf'}"} ${h.bins[i]}`),
    );
    lines.push(`${name}_count{route="${route}"} ${h.count}`, `${name}_sum{route="${route}"} ${h.sum}`);
  }
  return lines.join('\n') + '\n';
}

/** Migrate shared storage and start a stateless replica. close() stops admission, drains HTTP, then closes all pools. */
export async function startServer({ env = process.env, port, host } = {}) {
  const config = configuration(env),
    writer = createPool(config.url, config.ingestMax, 'upload'),
    reader = createPool(config.url, config.queryMax, 'query'),
    maint = createPool(config.url, 2, 'maintenance');
  const pools = [writer, reader, maint],
    endPools = () => Promise.all(pools.map((p) => p.end()));
  const counts = {
    inserted_events: 0,
    inserted_bytes: 0,
    accepted_events: 0,
    rejected_events: 0,
    retryable_events: 0,
    overloads: 0,
    storage_errors: 0,
    retention_deleted: 0,
  };
  const active = { ingest: 0, query: 0 },
    hist = { ingest: histogram(), query: histogram() },
    byProject = new Map();
  let stopping = false,
    retentionTimer,
    readyCheck;
  const server = createServer(
    { requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000, maxHeaderSize: 16384 },
    async (req, res) => {
      let lane,
        project,
        ids = 0;
      let originHeaders;
      const started = performance.now();
      const send = (status, body, headers = {}) => {
        if (res.headersSent || res.destroyed) return;
        const out = new Headers({ ...originHeaders, ...headers });
        if (!out.has('content-type') && body !== undefined) out.set('content-type', 'application/json; charset=utf-8');
        out.set('cache-control', 'no-store');
        out.set('x-content-type-options', 'nosniff');
        if (!req.complete) out.set('connection', 'close');
        res.writeHead(status, Object.fromEntries(out));
        res.end(
          body === undefined
            ? undefined
            : out.get('content-type').startsWith('application/json')
              ? JSON.stringify(body)
              : body,
        );
      };
      // Do not emit unhandled stream errors on client disconnects during body rejection.
      req.on('error', () => {});
      try {
        const url = new URL(req.url, 'http://logline.invalid'),
          path = url.pathname;
        if (path === '/health' && req.method === 'GET') return send(200, { status: 'ok' });
        if (stopping) throw fault(503, 'draining', 'Server is draining.');
        if (path === '/ready' && req.method === 'GET') {
          readyCheck ??= maint.query('SELECT 1').finally(() => {
            readyCheck = undefined;
          });
          await readyCheck;
          return send(200, { status: 'ready' });
        }
        if (path === '/api/v1/logs' && (req.method === 'POST' || req.method === 'OPTIONS')) {
          originHeaders = ingestOriginHeaders(req, config.origins);
          if (req.method === 'OPTIONS') return send(204);
        }
        const token = bearer(req);
        if (!token) throw fault(401, 'unauthorized', 'Bearer token required.');
        const upload = path === '/api/v1/logs' && req.method === 'POST';
        if (path.startsWith('/api/v1/admin/') || path === '/metrics') requireAdmin(token, config.adminToken);
        else if (upload) {
          if (!validProjectKey(token)) throw fault(401, 'unauthenticated', 'A valid project key is required.');
        } else if (!/^llpat_[A-Za-z0-9_-]{43}$/.test(token))
          throw fault(401, 'unauthenticated', 'A valid PAT is required.');
        if (path === '/metrics' && req.method === 'GET') {
          return send(200, metrics(counts, active, hist), { 'content-type': 'text/plain; version=0.0.4' });
        }
        if (path === '/mcp') {
          if (!config.mcp) throw fault(404, 'not_found', 'Route not found.');
          if (req.method !== 'POST') throw fault(405, 'method', 'Use POST.');
          if (req.headers.origin !== undefined) throw fault(403, 'origin', 'Browser origins are not accepted.');
        }
        const which = upload ? 'ingest' : 'query';
        if (active[which] >= (upload ? config.ingestMax : config.queryMax))
          throw fault(503, 'overload', 'Request capacity exceeded.');
        lane = which;
        active[lane]++;
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
          ? await readBody(req, config.maxBytes)
          : undefined;
        if (upload) {
          const id = envelope(body, config.maxEvents);
          ids = body.events.length;
          if ((byProject.get(id) ?? 0) >= Math.max(1, Math.ceil(config.ingestMax / 2)))
            throw fault(503, 'project_busy', 'Project upload capacity exceeded.');
          project = id;
          byProject.set(id, (byProject.get(id) ?? 0) + 1);
          const result = await ingest(writer, token, id, body, config),
            response = result.body;
          counts.inserted_events += result.inserted;
          counts.inserted_bytes += result.bytes;
          counts.accepted_events += response.acceptedEventIds.length;
          counts.rejected_events += response.rejectedEventIds.length;
          counts.retryable_events += response.retryableEventIds.length;
          if (result.status === 429) counts.overloads++;
          return send(
            result.status,
            response,
            response.retryAfterMs ? { 'retry-after': String(Math.ceil(response.retryAfterMs / 1000)) } : {},
          );
        }
        const ctx = { req, res, url, db: reader, body, send, token, adminToken: config.adminToken };
        const result = path.startsWith('/api/v1/admin/')
          ? await handleAdmin(ctx)
          : path === '/mcp'
            ? await handleMcp(ctx)
            : await handleExplorer(ctx);
        if (result === true || res.headersSent) return;
        if (result && Number.isInteger(result.status)) return send(result.status, result.body, result.headers);
        throw fault(404, 'not_found', 'Route not found.');
      } catch (error) {
        const known = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599;
        const status = known ? error.status : 503,
          code = known ? error.code : 'storage_unavailable';
        if (!known) counts.storage_errors++;
        if (status === 503 || status === 429) {
          counts.overloads++;
          counts.retryable_events += ids;
        }
        send(
          status,
          { error: { code, message: known ? error.message : 'Service temporarily unavailable.' } },
          status === 503 || status === 429 ? { 'retry-after': '1' } : {},
        );
      } finally {
        if (lane) {
          // A bounded export still occupies its slot until Node drains it; slow consumers cannot create an extra response queue.
          if (!res.writableFinished && !res.destroyed) {
            await new Promise((resolve) => {
              const done = () => {
                clearTimeout(deadline);
                res.off('finish', done);
                res.off('close', done);
                resolve();
              };
              const deadline = setTimeout(() => res.destroy(), 10000).unref();
              res.once('finish', done).once('close', done);
            });
          }
          active[lane]--;
          observe(hist[lane], (performance.now() - started) / 1000);
        }
        if (project) {
          const n = byProject.get(project) - 1;
          if (n) byProject.set(project, n);
          else byProject.delete(project);
        }
      }
    },
  );
  server.maxConnections = Math.max(256, 16 * (config.ingestMax + config.queryMax));
  try {
    await migrate(maint);
    await new Promise((resolve, reject) =>
      server.once('error', reject).listen(port ?? config.port, host ?? config.host, resolve),
    );
  } catch (error) {
    await endPools();
    throw error;
  }
  const sweep = async () => {
    let delay = 60000;
    try {
      const n = await prune(maint, config.days);
      counts.retention_deleted += n;
      if (n === 5000) delay = 1000;
    } catch {
      counts.storage_errors++;
    }
    if (!stopping) retentionTimer = setTimeout(sweep, delay).unref();
  };
  retentionTimer = setTimeout(sweep, 1000).unref();
  let closing;
  return {
    server,
    close() {
      closing ??= (async () => {
        stopping = true;
        clearTimeout(retentionTimer);
        const force = setTimeout(() => server.closeAllConnections(), 15000).unref();
        try {
          await new Promise((resolve) => server.close(resolve));
        } finally {
          clearTimeout(force);
          await endPools();
        }
      })();
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const app = await startServer();
    process.stdout.write(`logline: listening on port ${app.server.address().port}\n`);
    for (const signal of ['SIGTERM', 'SIGINT'])
      process.once(signal, () => {
        void app.close().catch(() => {
          process.exitCode = 1;
        });
      });
  } catch {
    process.stderr.write('logline: startup failed; verify database, schema and deployment configuration\n');
    process.exitCode = 1;
  }
}
