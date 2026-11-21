// Real HTTP workload. Use a disposable deployment: every run creates new projects and a user.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const env = process.env;
const number = (key, fallback, min, max) => {
  const n = Number(env[key] ?? fallback);
  assert(Number.isSafeInteger(n) && n >= min && n <= max, `Invalid ${key}`);
  return n;
};
const urls = (env.BENCH_URLS ?? 'http://127.0.0.1:4318').split(',').map((s) => new URL(s).origin);
const admin = env.LOGLINE_ADMIN_TOKEN;
assert(
  admin && env.BENCH_DISPOSABLE === 'yes',
  'Set BENCH_DISPOSABLE=yes and LOGLINE_ADMIN_TOKEN on an isolated server',
);
const profile = {
  replicas: urls.length,
  projects: number('PROJECTS', 24, 2, 100),
  seconds: number('SECONDS_TO_RUN', 120, 2, 1800),
  eventsPerSecond: number('RATE', 1000, 1, 50000),
  batch: number('BATCH', 50, 1, 500),
  writers: number('WRITERS', 6, 1, 64),
  readers: number('READERS', 3, 0, 32),
  hot: env.HOT === '1',
  mcp: env.BENCH_MCP === '1',
  padding: number('PAD', 192, 0, 8192),
};
const run = randomUUID().slice(0, 8);
let nextReplica = 0;
async function request(path, token, body, method = 'POST', target = urls[nextReplica++ % urls.length]) {
  try {
    const res = await fetch(target + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const data = res.status === 204 ? {} : await res.json();
    return { status: res.status, data, wait: Number(res.headers.get('retry-after') ?? 0) * 1000 };
  } catch {
    return { status: 0, data: {}, wait: 0 };
  }
}
async function setup(path, body, method) {
  const { status, data } = await request('/api/v1/admin' + path, admin, body, method);
  assert(status >= 200 && status < 300, `Fixture setup ${path}: HTTP ${status}`);
  return data;
}
const { userId } = await setup('/users', { displayName: `Benchmark ${run}` });
const permissions = ['logs:read', 'logs:write'];
const projects = [];
for (let i = 0; i < profile.projects; i++) {
  const { projectId } = await setup('/projects', { slug: `bench-${run}-${i}`, displayName: `Synthetic ${i}` });
  await setup(`/projects/${projectId}/members/${userId}`, { permissions }, 'PUT');
  projects.push(projectId);
}
const { secret, tokenId } = await setup(`/users/${userId}/tokens`, { scopes: permissions });
const acks = projects.map(() => 0),
  offered = projects.map(() => 0),
  statuses = {},
  failures = {},
  samples = {};
const inc = (obj, k, amount = 1) => (obj[k] = (obj[k] ?? 0) + amount);
const record = (name, ms) => {
  (samples[name] ??= []).push(ms);
};
let bytes = 0,
  offeredBytes = 0,
  retryAttempts = 0,
  deferred = 0,
  visibilityFailures = 0,
  ackErrors = 0,
  inFlight = 0,
  maxInFlight = 0,
  serial = 0;
let replay,
  firstAckAfterFailureMs = null,
  lastFailedAt = 0;
const start = performance.now(),
  end = start + profile.seconds * 1000;
const markStatus = (type, status) => inc(statuses, `${type}:${status}`);
async function writer(w) {
  const every = (1000 * profile.batch * profile.writers) / profile.eventsPerSecond;
  let due = start + (w * every) / profile.writers;
  while (due < end) {
    await delay(Math.max(0, due - performance.now()));
    if (performance.now() >= end) break;
    const seq = serial++,
      index =
        profile.hot && w < Math.ceil(profile.writers * 0.75)
          ? 0
          : profile.hot
            ? 1 + (seq % (projects.length - 1))
            : seq % projects.length;
    const projectId = projects[index];
    const timestamp = Date.now();
    const events = Array.from({ length: profile.batch }, (_, i) => ({
      id: `${run}-${seq}-${i}`,
      timestamp,
      level: i % 10 ? 'LOG' : 'ERROR',
      message: 'Synthetic sample ' + 'x'.repeat(profile.padding),
      fields: { sample: i },
      context: { environment: 'bench', traceId: `trace-${seq % 64}` },
    }));
    const batch = { projectId, service: 'synthetic-load', events };
    const size = Buffer.byteLength(JSON.stringify(batch));
    offered[index] += events.length;
    offeredBytes += size;
    inFlight += events.length;
    maxInFlight = Math.max(inFlight, maxInFlight);
    const sent = performance.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = performance.now(),
        { status, data, wait } = await request('/api/v1/logs', secret, batch);
      markStatus('upload', status);
      record('uploadAttemptMs', performance.now() - t);
      if (
        status === 200 &&
        Array.isArray(data.acceptedEventIds) &&
        data.acceptedEventIds.length === events.length &&
        new Set(data.acceptedEventIds).size === events.length &&
        events.every((e) => data.acceptedEventIds.includes(e.id))
      ) {
        const ack = performance.now();
        if (lastFailedAt) {
          firstAckAfterFailureMs = Math.round(ack - lastFailedAt);
          lastFailedAt = 0;
        }
        acks[index] += events.length;
        bytes += size;
        record('uploadAckMs', ack - sent);
        replay ??= batch;
        if (seq % 40 === 0) {
          const visible = await request('/api/v1/explorer/detail', secret, { projectId, eventId: events[0].id });
          if (visible.status === 200 && visible.data.item?.eventId === events[0].id)
            record('ackToVisibleMs', performance.now() - ack);
          else visibilityFailures++;
        }
        break;
      }
      if (status === 200) {
        ackErrors++;
        break;
      }
      lastFailedAt = performance.now();
      if (![0, 429, 503, 502, 504, 500].includes(status)) {
        inc(failures, `upload:${status}`);
        break;
      }
      const pause = Math.max(wait, 250 * 2 ** attempt);
      if (attempt === 2 || performance.now() + pause >= end) {
        deferred += events.length;
        break;
      }
      retryAttempts++;
      await delay(pause);
    }
    inFlight -= events.length;
    // No unbounded producer queue or catch-up burst if delivery stalls.
    due = Math.max(due + every, performance.now());
  }
}
async function reader(w) {
  let i = w,
    cursor;
  const actions = ['rows', 'series', 'groups', 'refresh', 'export', ...(profile.mcp ? ['mcp'] : [])];
  while (performance.now() < end) {
    const action = actions[i++ % actions.length],
      projectId = projects[w % projects.length];
    const query = {
      projectIds: [projectId],
      range: { last: '1h' },
      where: { field: 'level', op: 'eq', value: 'ERROR' },
    };
    let body = { query, limit: 10 };
    if (action === 'series' || action === 'groups') body.groupBy = ['level'];
    if (action === 'series') body.intervalSeconds = 300;
    if (action === 'refresh' && cursor) body.cursor = cursor;
    if (action === 'export') Object.assign(body, { format: 'jsonl', columns: ['timestamp', 'message'] });
    if (action === 'mcp')
      body = { jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'logline_rows', arguments: body } };
    const t = performance.now(),
      { status, data } = await request(action === 'mcp' ? '/mcp' : `/api/v1/explorer/${action}`, secret, body);
    markStatus(action, status);
    record('queryAttemptMs', performance.now() - t);
    record(`${action}Ms`, performance.now() - t);
    if (status !== 200 || data.error || data.result?.isError) inc(failures, action);
    else if (action === 'refresh') cursor = data.nextCursor;
    await delay(100);
  }
}
process.stderr.write(`load-start ${new Date().toISOString()}\n`);
await Promise.all([
  ...Array.from({ length: profile.writers }, (_, i) => writer(i)),
  ...Array.from({ length: profile.readers }, (_, i) => reader(i)),
]);
const wallSeconds = (performance.now() - start) / 1000;
let replayOk = false;
if (replay) {
  const r = await request('/api/v1/logs', secret, replay);
  replayOk = r.status === 200 && r.data.acceptedEventIds?.length === replay.events.length;
}
// Each project is private to this run, so group counts reconcile exclusive acknowledged logical identities.
const counts = [];
for (const projectId of projects) {
  const { data, status } = await request('/api/v1/explorer/groups', secret, {
    query: { projectIds: [projectId], range: { last: '1h' } },
    metric: { op: 'count' },
  });
  counts.push(status === 200 ? (data.items?.[0]?.value ?? 0) : null);
}
// Exercise revocation on all explicit replica URLs with a previously working PAT.
await setup(`/users/${userId}/tokens/${tokenId}`, undefined, 'DELETE');
const revokedStatus = await Promise.all(
  urls.map((target) => request('/api/v1/explorer/projects', secret, undefined, 'GET', target).then((r) => r.status)),
);
const summarize = (values) => {
  values.sort((a, b) => a - b);
  const percentile = (p) => Number(values[Math.ceil(values.length * p) - 1].toFixed(2));
  return { n: values.length, p95: percentile(0.95), p99: percentile(0.99) };
};
const accepted = acks.reduce((a, b) => a + b, 0),
  generated = offered.reduce((a, b) => a + b, 0);
const report = {
  profile,
  wallSeconds,
  generated,
  accepted,
  offeredBytes,
  acceptedBytes: bytes,
  eventsPerSec: accepted / wallSeconds,
  bytesPerSec: bytes / wallSeconds,
  statuses,
  failures,
  retryAttempts,
  deferred,
  ackErrors,
  maxClientInflightEvents: maxInFlight,
  firstAckAfterFailureMs,
  visibilityFailures,
  latency: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, summarize(v)])),
  replayOk,
  counts,
  acks,
  offered,
  revokedStatus,
};
console.log(JSON.stringify(report, null, 2));
if (
  !accepted ||
  !replayOk ||
  ackErrors ||
  visibilityFailures ||
  counts.some((n, i) => n !== acks[i]) ||
  revokedStatus.some((s) => ![401, 403].includes(s)) ||
  Object.keys(failures).length
)
  process.exitCode = 1;
