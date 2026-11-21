// Run via kubernetes-rollout.sh inside a dedicated probe pod. Files are on its emptyDir.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const clusterUrl = 'http://logline-server:4318';
const endpoints = (s) =>
  s
    .trim()
    .split(/\s+/)
    .map((ip) => `http://${ip.includes(':') ? '[' + ip + ']' : ip}:4318`);
const old = endpoints(process.env.PODS);
assert.equal(old.length, 2);
const admin = process.env.LOGLINE_ADMIN_TOKEN;
async function call(base, path, token, body, method = 'POST') {
  try {
    const res = await fetch(base + path, {
      method,
      headers: { authorization: 'Bearer ' + token, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  } catch {
    return { status: 0 };
  }
}
async function manage(base, path, data, method) {
  const r = await call(base, '/api/v1/admin' + path, admin, data, method);
  assert(r.status >= 200 && r.status < 300, `admin ${path}: ${r.status}`);
  return r.body;
}
const run = randomUUID().slice(0, 8);
const { userId } = await manage(old[0], '/users', { displayName: 'Rolling verification' });
const { projectId } = await manage(old[1], '/projects', {
  slug: 'rolling-' + run,
  displayName: 'Synthetic rollback check',
});
const { secret } = await manage(old[0], `/users/${userId}/tokens`, { scopes: ['logs:read'] });
const detail = (base, eventId) => call(base, '/api/v1/explorer/detail', secret, { projectId, eventId });
assert.equal((await detail(old[1], 'marker')).status, 403);
const grant = `/projects/${projectId}/members/${userId}`;
await manage(old[0], grant, { permissions: ['logs:read'] }, 'PUT');
const keyPath = `/projects/${projectId}/keys`;
const { key, keyId } = await manage(old[1], keyPath, { name: 'Synthetic rollout writer' });
const events = new Map();
const upload = (base, event) => call(base, '/api/v1/logs', key, { projectId, events: [event] });
const event = (id) => ({ id, timestamp: Date.now(), level: 'LOG', message: 'Synthetic rollout verification' });
const marker = event('marker');
assert.deepEqual((await upload(old[0], marker)).body.acceptedEventIds, ['marker']);
events.set('marker', marker);
assert.equal((await detail(old[1], 'marker')).status, 200);
writeFileSync('/tmp/rolling-ready', 'ready');
const statuses = {},
  queries = {},
  deadline = Date.now() + 180000;
let attempts = 0;
while (!existsSync('/tmp/rolling-new-pods')) {
  assert(Date.now() < deadline, 'Rollout did not finish');
  const e = event('rolling-' + attempts++),
    [r, q] = await Promise.all([upload(clusterUrl, e), detail(clusterUrl, 'marker')]);
  queries[q.status] = (queries[q.status] ?? 0) + 1;
  if (q.status === 200) assert.equal(q.body.item.eventId, 'marker');
  else assert([0, 502, 503, 504].includes(q.status));
  statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  if (r.status === 200) {
    assert.deepEqual(r.body.acceptedEventIds, [e.id]);
    events.set(e.id, e);
  } else assert([0, 502, 503, 504].includes(r.status));
  await delay(75);
}
const fresh = endpoints(readFileSync('/tmp/rolling-new-pods', 'utf8'));
assert.equal(fresh.length, 2);
assert(attempts > 1 && events.size > 1);
let i = 0;
for (const e of events.values()) {
  const r = await detail(fresh[i++ % 2], e.id);
  assert.equal(r.body?.item?.eventId, e.id, 'Acknowledged record lost');
  assert.equal(r.body.item.ingestKeyId, keyId, 'Ingest credential attribution lost');
}
assert.deepEqual((await upload(fresh[0], marker)).body.acceptedEventIds, ['marker']);
const grouped = await call(fresh[1], '/api/v1/explorer/groups', secret, { query: { projectIds: [projectId] } });
assert.equal(grouped.body.items[0].value, events.size, 'Duplicate or missing row');
await manage(fresh[0], grant, undefined, 'DELETE');
const revoked = await Promise.all(fresh.map((ep) => detail(ep, 'marker').then((r) => r.status)));
assert.deepEqual(revoked, [403, 403]);
// Revoking a reader's grant cannot affect a project-owned writer.
assert.deepEqual((await upload(fresh[1], marker)).body.acceptedEventIds, ['marker']);
await manage(fresh[0], `${keyPath}/${keyId}`, undefined, 'DELETE');
const revokedKey = await Promise.all(fresh.map((ep) => upload(ep, marker).then((r) => r.status)));
assert.deepEqual(revokedKey, [401, 401]);
console.log(
  JSON.stringify(
    {
      uploadStatuses: statuses,
      queryStatuses: queries,
      verifiedRows: events.size,
      replayCount: grouped.body.items[0].value,
      revoked,
      revokedKey,
    },
    null,
    2,
  ),
);
