import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { envelope, partition } from '../src/ingest.mjs';
import { prune } from '../src/db.mjs';

const event = (id, extra = {}) => ({
  id,
  level: 'LOG',
  timestamp: 1700000000000,
  message: 'Synthetic observation',
  ...extra,
});

test('IDs must identify exactly one member of a bounded envelope', () => {
  const data = { projectId: randomUUID(), service: 'example', events: [event('1')] };
  assert.equal(envelope(data, 1), data.projectId);
  for (const value of [
    { ...data, events: [] },
    { ...data, service: ' ' },
    { ...data, projectId: 'slug' },
    { ...data, events: [{}] },
    { ...data, events: [event('x'), event('x')] },
  ])
    assert.throws(() => envelope(value, 2), { status: 400 });
  assert.throws(() => envelope({ ...data, events: [event('1'), event('2')] }, 1), { status: 413 });
});

test('one malformed event never spoils its valid neighbors', () => {
  let deep = {};
  for (let i = 0; i < 30; i++) deep = { nested: deep };
  const values = [
    { timestamp: -1 },
    { timestamp: 1.2 },
    { level: 'info' },
    { message: 2 },
    { message: '\ud800' },
    { fields: { bad: '\0' } },
    { fields: [] },
    { context: { sessionId: 2 } },
    { huge: 'a'.repeat(65536) },
    { extra: deep },
    { fields: { number: Infinity } },
  ];
  const { valid, rejectedEventIds } = partition([
    event('ok', { fields: { duration: 2 }, context: { environment: 'synthetic' } }),
    ...values.map((v, i) => event(String(i), v)),
  ]);
  assert.deepEqual(
    valid.map((v) => v.event.id),
    ['ok'],
  );
  assert.deepEqual(
    rejectedEventIds,
    values.map((_, i) => String(i)),
  );
});

test(
  'replicas share ownership, idempotency and quota; acknowledgment survives a replica restart',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 },
  async () => {
    const { startServer } = await import('../src/server.mjs');
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = 'test_ingest_' + randomBytes(8).toString('hex');
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    const store = new pg.Pool({ connectionString: url.href }),
      adminToken = randomBytes(32).toString('hex');
    const env = {
      DATABASE_URL: url.href,
      LOGLINE_ADMIN_TOKEN: adminToken,
      PROJECT_EVENTS_PER_MINUTE: '4',
      PROJECT_BYTES_PER_MINUTE: '4000',
    };
    let a, b;
    const start = () => startServer({ env, host: '127.0.0.1', port: 0 });
    const call = async (server, method, path, token, body) => {
      const r = await fetch(`http://127.0.0.1:${server.server.address().port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: r.status,
        headers: r.headers,
        body:
          r.status === 204
            ? undefined
            : r.headers.get('content-type')?.startsWith('text/')
              ? await r.text()
              : await r.json(),
      };
    };
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      [a, b] = await Promise.all([start(), start()]);
      const admin = async (method, path, body) => {
        const r = await call(a, method, '/api/v1/admin' + path, adminToken, body);
        assert.ok(r.status < 300, JSON.stringify(r));
        return r.body;
      };
      const { userId } = await admin('POST', '/users', { displayName: 'Fixture Writer' });
      const { projectId } = await admin('POST', '/projects', { displayName: 'Example', slug: 'synthetic_api' });
      await admin('PUT', `/projects/${projectId}/members/${userId}`, { permissions: ['logs:write'] });
      const { secret, tokenId } = await admin('POST', `/users/${userId}/tokens`, { scopes: ['logs:write'] });
      const upload = (s, events, token = secret, project = projectId) =>
        call(s, 'POST', '/api/v1/logs', token, { projectId: project, service: 'spec', events });
      assert.equal((await upload(b, [event('e')], adminToken)).status, 401);
      assert.equal((await upload(b, [event('e')], secret, randomUUID())).status, 403);
      const [r1, r2] = await Promise.all([
        upload(a, [event('e'), event('bad', { level: 'INVALID' })]),
        upload(b, [event('e')]),
      ]);
      assert.deepEqual(r1.body, { acceptedEventIds: ['e'], rejectedEventIds: ['bad'], retryableEventIds: [] });
      assert.deepEqual(r2.body.acceptedEventIds, ['e']);
      assert.equal((await store.query('SELECT count(*)::int AS n FROM log_events')).rows[0].n, 1);
      assert.equal((await store.query('SELECT events::int AS n FROM log_ingest_quota')).rows[0].n, 1);
      const oversized = await upload(b, [event('big', { message: 'a'.repeat(5000) })]);
      assert.equal(oversized.status, 429);
      const retry = await upload(
        b,
        ['e', '1', '2', '3', '4', '5'].map((id) => event(id)),
      );
      assert.equal(retry.status, 429);
      assert.ok(+retry.headers.get('retry-after') >= 1);
      assert.deepEqual(retry.body.acceptedEventIds, ['e']);
      assert.deepEqual(retry.body.retryableEventIds, ['1', '2', '3', '4', '5']);
      assert.equal((await upload(a, [event('1'), event('2'), event('3')])).status, 200);
      // Racing the minute boundary may reset the window. Check cross-replica conservation independently of wall clock.
      assert.equal((await store.query('SELECT count(*)::int AS n FROM log_events')).rows[0].n, 4);
      // A blocked storage transaction must time out WITHOUT an acknowledgment. A second project can still write.
      const other = await admin('POST', '/projects', { displayName: 'Neighbor', slug: 'fixture_neighbor' });
      await admin('PUT', `/projects/${other.projectId}/members/${userId}`, { permissions: ['logs:write'] });
      const locker = await store.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT project_id FROM log_ingest_quota WHERE project_id=$1 FOR UPDATE', [projectId]);
        const [blocked, neighbor] = await Promise.all([
          upload(b, [event('e')]),
          upload(b, [event('e')], secret, other.projectId),
        ]);
        assert.equal(blocked.status, 503);
        assert.equal(blocked.headers.get('retry-after'), '1');
        assert.deepEqual(neighbor.body.acceptedEventIds, ['e']);
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
      }
      assert.deepEqual((await upload(b, [event('e')])).body.acceptedEventIds, ['e']);
      await a.close();
      a = await start();
      assert.deepEqual((await upload(a, [event('e', { message: 'changed' })])).body.acceptedEventIds, ['e']);
      assert.equal(
        (await store.query("SELECT message FROM log_events WHERE event_id='e'")).rows[0].message,
        'Synthetic observation',
      );
      assert.match((await call(b, 'GET', '/metrics', adminToken)).body, /logline_request_duration_seconds_bucket/);
      assert.equal((await call(b, 'GET', '/metrics', secret)).status, 401);
      assert.equal((await call(b, 'GET', '/ready')).status, 200);
      const malformed = await fetch(`http://127.0.0.1:${b.server.address().port}/api/v1/logs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: '{',
      });
      assert.equal(malformed.status, 400);
      await admin('DELETE', `/users/${userId}/tokens/${tokenId}`);
      assert.equal((await upload(b, [event('x')])).status, 401);
      await store.query(
        "UPDATE log_events SET received_at=now()-interval '32 days' WHERE project_id=$1 AND event_id='e'",
        [projectId],
      );
      assert.equal(await prune(store, 30), 1);
      assert.equal(
        (await store.query('SELECT count(*)::int AS n FROM log_events WHERE project_id=$1', [projectId])).rows[0].n,
        3,
      );
    } finally {
      await Promise.all([a?.close(), b?.close()]);
      await store.end();
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await db.end();
    }
  },
);
