import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { ingestOrigins } from '../src/ingest-origin.mjs';
import { startServer } from '../src/server.mjs';

const site = 'https://app.example.org';
test('browser ingestion accepts exact origins only and is disabled by default', () => {
  assert.equal(ingestOrigins().size, 0);
  assert.deepEqual([...ingestOrigins(`${site}, http://localhost:8080`)], [site, 'http://localhost:8080']);
  for (const invalid of [
    '*',
    'https://*.example.org',
    'null',
    'file://',
    `${site}/path`,
    `${site}?a`,
    'https://user@app.example.org',
  ])
    assert.throws(() => ingestOrigins(invalid), /LOGLINE_INGEST_ORIGINS/);
});

test(
  'browser preflight is limited to ingestion and never replaces DSN authentication',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = 'test_origins_' + randomBytes(8).toString('hex');
    await db.query(`CREATE SCHEMA ${schema}`);
    let replica;
    t.after(async () => {
      try {
        await replica?.close();
      } finally {
        try {
          await db.query(`DROP SCHEMA ${schema} CASCADE`);
        } finally {
          await db.end();
        }
      }
    });
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    const admin = randomBytes(32).toString('hex');
    replica = await startServer({
      env: { DATABASE_URL: url.href, LOGLINE_ADMIN_TOKEN: admin, LOGLINE_INGEST_ORIGINS: site },
      port: 0,
      host: '127.0.0.1',
    });
    const base = `http://127.0.0.1:${replica.server.address().port}/api/v1/`;
    const preflight = (path, origin, method = 'POST', headers = 'authorization,content-type') =>
      fetch(base + path, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': method, 'access-control-request-headers': headers },
      });
    const ok = await preflight('logs', site);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), site);
    assert.equal(ok.headers.get('access-control-allow-credentials'), null);
    assert.equal((await preflight('logs', site + '.invalid')).status, 403);
    assert.equal((await preflight('logs', site, 'GET')).status, 403);
    assert.equal((await preflight('logs', site, 'POST', 'x-custom')).status, 403);
    for (const path of ['admin/projects', 'explorer/search'])
      assert.equal((await preflight(path, site)).headers.get('access-control-allow-origin'), null);
    const post = (path, token, body, origin) =>
      fetch(base + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token && { authorization: `Bearer ${token}` }),
          ...(origin && { origin }),
        },
        body: JSON.stringify(body),
      });
    const denied = await post('logs', undefined, {}, site);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('access-control-allow-origin'), site);
    const project = await post('admin/projects', admin, { slug: 'browser', displayName: 'Browser' });
    assert.equal(project.status, 201);
    const { projectId } = await project.json();
    const minted = await post(`admin/projects/${projectId}/keys`, admin, { name: 'browser' });
    assert.equal(minted.status, 201);
    const { key } = await minted.json();
    const event = { id: 'browser-event', message: 'hello', level: 'LOG', timestamp: 1700000000000 };
    const body = { projectId, events: [event] };
    assert.equal((await post('logs', key, body, 'https://unlisted.example.org')).status, 403);
    const accepted = await post('logs', key, body, site);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('access-control-allow-origin'), site);
    assert.deepEqual((await accepted.json()).acceptedEventIds, [event.id]);
  },
);
