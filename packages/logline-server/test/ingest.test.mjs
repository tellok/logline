import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { authorize, digest } from '../src/auth.mjs';
import { envelope, partition } from '../src/ingest.mjs';
import { migrate, prune } from '../src/db.mjs';

const event = (id, extra = {}) => ({
  id,
  level: 'LOG',
  timestamp: 1700000000000,
  message: 'Synthetic observation',
  ...extra,
});

test('IDs must identify exactly one member of a bounded envelope', () => {
  const data = { projectId: randomUUID(), events: [event('1')] };
  assert.equal(envelope(data, 1), data.projectId);
  for (const value of [
    { ...data, events: [] },
    { ...data, service: 'retired' },
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
    { ingestKeyId: randomUUID() },
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
      const { projectId } = await admin('POST', '/projects', { displayName: 'Example', slug: 'synthetic_api' });
      const { key: secret, keyId } = await admin('POST', `/projects/${projectId}/keys`, { name: 'Fixture Writer' });
      const upload = (s, events, token = secret, project = projectId) =>
        call(s, 'POST', '/api/v1/logs', token, { projectId: project, events });
      assert.equal((await upload(b, [event('e')], adminToken)).status, 401);
      assert.equal((await upload(b, [event('e')], secret, randomUUID())).status, 403);
      const [r1, r2] = await Promise.all([
        upload(a, [event('e'), event('bad', { level: 'INVALID' })]),
        upload(b, [event('e')]),
      ]);
      assert.deepEqual(r1.body, { acceptedEventIds: ['e'], rejectedEventIds: ['bad'], retryableEventIds: [] });
      assert.deepEqual(r2.body.acceptedEventIds, ['e']);
      assert.equal((await store.query('SELECT count(*)::int AS n FROM log_events')).rows[0].n, 1);
      const { key: replacement } = await admin('POST', `/projects/${projectId}/keys`, { name: 'Replacement' });
      assert.deepEqual((await upload(b, [event('e')], replacement)).body.acceptedEventIds, ['e']);
      assert.equal((await store.query('SELECT ingest_key_id FROM log_events')).rows[0].ingest_key_id, keyId);
      const {
        rows: [storedKey],
      } = await store.query('SELECT * FROM project_keys WHERE key_id=$1', [keyId]);
      assert.deepEqual(storedKey.secret_digest, digest(secret));
      assert.ok(!JSON.stringify(storedKey).includes(secret));
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
      const { key: neighborKey } = await admin('POST', `/projects/${other.projectId}/keys`, { name: 'Neighbor' });
      const locker = await store.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT project_id FROM log_ingest_quota WHERE project_id=$1 FOR UPDATE', [projectId]);
        const [blocked, neighbor] = await Promise.all([
          upload(b, [event('e')]),
          upload(b, [event('e')], neighborKey, other.projectId),
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
      await admin('DELETE', `/projects/${projectId}/keys/${keyId}`);
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

// Recreate the v1 catalog differences explicitly; the fixture works in packed checkouts without Git history.
test(
  'concurrent v1 upgrades preserve events, read access and identities without granting former writers read access',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = 'migration_' + randomBytes(8).toString('hex');
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    const db = new pg.Pool({ connectionString: url.href });
    try {
      await root.query(`CREATE SCHEMA ${schema}`);
      await migrate(db);
      await db.query(`ALTER TABLE log_events DROP COLUMN ingest_key_id; DROP TABLE project_keys; ALTER TABLE log_events ADD COLUMN service text NOT NULL;
        UPDATE logline_schema_versions SET version=1;`);
      for (const [table, column] of [
        ['user_tokens', 'scopes'],
        ['direct_grants', 'permissions'],
        ['team_grants', 'permissions'],
      ]) {
        await db.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_${column}_check,
          ADD CHECK (cardinality(${column}) BETWEEN 1 AND 2 AND ${column} <@ ARRAY['logs:read','logs:write'])`);
      }
      const {
        rows: [{ project_id: p }],
      } = await db.query("INSERT INTO projects(slug,display_name) VALUES ('v1','Migration') RETURNING project_id");
      const { rows: users } = await db.query(
        "INSERT INTO users(display_name) VALUES ('Former writer'),('Reader'),('Member') RETURNING user_id",
      );
      const ids = users.map((u) => u.user_id);
      const {
        rows: [{ team_id: team }],
      } = await db.query("INSERT INTO teams(display_name) VALUES ('Fixture') RETURNING team_id");
      const pat = () => 'llpat_' + randomBytes(32).toString('base64url');
      const writeOnly = pat(),
        mixed = pat(),
        readOnly = pat();
      await db.query(
        `INSERT INTO user_tokens(user_id,secret_digest,scopes) VALUES
        ($1,$2,'{logs:write}'),($3,$4,'{logs:read,logs:write}'),($5,$6,'{logs:read}')`,
        [ids[0], digest(writeOnly), ids[1], digest(mixed), ids[2], digest(readOnly)],
      );
      await db.query(`INSERT INTO direct_grants VALUES ($1,$3,'{logs:write}'),($2,$3,'{logs:write,logs:read}')`, [
        ids[0],
        ids[1],
        p,
      ]);
      await db.query('INSERT INTO team_members VALUES ($1,$2)', [team, ids[2]]);
      await db.query("INSERT INTO team_grants VALUES ($1,$2,'{logs:write}')", [team, p]);
      const e = event('migration');
      await db.query(
        `INSERT INTO log_events (project_id,event_id,service,level,timestamp_ms,message,fields,context,event) VALUES ($1,$2,'retired','LOG',$3,$4,'{}','{}',$5)`,
        [p, e.id, e.timestamp, e.message, e],
      );
      await Promise.all([migrate(db), migrate(db)]);
      assert.deepEqual(
        (await db.query('SELECT version FROM logline_schema_versions ORDER BY version')).rows.map((x) => x.version),
        [1, 2],
      );
      assert.deepEqual((await db.query('SELECT project_id,event,ingest_key_id FROM log_events')).rows, [
        { project_id: p, event: e, ingest_key_id: null },
      ]);
      assert.equal(
        (
          await db.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='log_events' AND column_name='service'",
          )
        ).rowCount,
        0,
      );
      assert.equal((await db.query('SELECT * FROM project_keys')).rowCount, 0);
      await assert.rejects(authorize(db, writeOnly, 'logs:read', [p]), { status: 401 });
      await assert.rejects(authorize(db, readOnly, 'logs:read', [p]), { status: 403 });
      assert.equal((await authorize(db, mixed, 'logs:read', [p])).projects[0].projectId, p);
      const {
        rows: [old],
      } = await db.query('SELECT scopes,revoked_at FROM user_tokens WHERE user_id=$1', [ids[0]]);
      assert.ok(old.revoked_at);
      assert.deepEqual(old.scopes, []);
      assert.deepEqual((await db.query('SELECT permissions FROM direct_grants')).rows, [
        { permissions: ['logs:read'] },
      ]);
      assert.equal((await db.query('SELECT * FROM team_grants')).rowCount, 0);
    } finally {
      await db.end();
      await root.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await root.end();
    }
  },
);
