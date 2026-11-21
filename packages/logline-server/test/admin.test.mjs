import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { startServer } from '../src/server.mjs';
import { test } from 'node:test';
import pg from 'pg';
import { authorize, bearer, requireAdmin } from '../src/auth.mjs';

const admin = randomBytes(32).toString('hex');
const read = 'logs:read';

test('bootstrap and PAT credentials occupy separate namespaces and fail closed', async () => {
  assert.equal(bearer({ headers: { authorization: 'Bearer a, Bearer b' } }), undefined);
  assert.throws(() => requireAdmin('short', 'short'), { status: 401 });
  assert.throws(() => requireAdmin(undefined, undefined), { status: 401 });
  assert.throws(() => requireAdmin('llpat_' + admin, 'llpat_' + admin), { status: 401 });
  assert.throws(() => requireAdmin('llpk_' + admin, 'llpk_' + admin), { status: 401 });
  assert.doesNotThrow(() => requireAdmin(admin, admin));
  await assert.rejects(authorize(null, admin, read), { status: 401 });
});

// Start independent ingress replicas; the only shared data is PostgreSQL and the injected admin secret.
async function replica(databaseUrl) {
  const app = await startServer({
    host: '127.0.0.1',
    port: 0,
    env: { DATABASE_URL: databaseUrl, LOGLINE_ADMIN_TOKEN: admin },
  });
  return { ...app, base: `http://127.0.0.1:${app.server.address().port}/api/v1/admin` };
}

test(
  'management HTTP and live PAT authorization across replicas',
  { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a disposable PostgreSQL primary' },
  async (t) => {
    const connectionString = process.env.TEST_DATABASE_URL;
    const control = new pg.Client({ connectionString });
    await control.connect();
    const schema = 'admin_test_' + randomUUID().replaceAll('-', '');
    const pools = [],
      servers = [];
    t.after(async () => {
      for (const s of servers) await s.close();
      await Promise.all(pools.map((pool) => pool.end()));
      try {
        await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await control.end();
      }
    });
    await control.query(`CREATE SCHEMA ${schema}`);
    for (let i = 0; i < 2; i++) pools.push(new pg.Pool({ connectionString, options: `-c search_path=${schema}` }));
    const databaseUrl = new URL(connectionString);
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    for (let i = 0; i < 2; i++) servers.push(await replica(databaseUrl.href));
    let index = 0;
    async function call(method, path, body, expected = 200, token = admin) {
      const base = servers[index++ % 2].base;
      const response = await fetch(path.startsWith('/api/') ? new URL(path, base) : base + path, {
        method,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const obj = response.status === 204 ? undefined : await response.json();
      assert.equal(response.status, expected, `${method} ${path}: status ${response.status}, code ${obj?.error?.code}`);
      if (expected < 300) assert.equal(response.headers.get('cache-control'), 'no-store');
      else assert.equal(typeof obj.error.code, 'string');
      return obj;
    }
    const create = (path, body) => call('POST', path, body, 201);
    const get = (path) => call('GET', path);
    const put = (path, body) => call('PUT', path, body, 204);
    const del = (path) => call('DELETE', path, undefined, 204);
    const pat = (userId, scopes) => create(`/users/${userId}/tokens`, { scopes, label: 'Fixture' });
    const grant = (p, m, id) => `/projects/${p}/${m}/${id}`;
    const users = '/users',
      projects = '/projects',
      teams = '/teams';
    const { userId: u } = await create(users, { displayName: 'Example owner' });
    const { teamId: a } = await create(teams, { displayName: 'First team' });
    const { teamId: b } = await create(teams, { displayName: 'Second team' });
    const p1 = await create(projects, { slug: 'payments-api_v2', displayName: '支付服务' });
    const p2 = await create(projects, { slug: 'billing', displayName: '支付服务' });
    const p = p1.projectId,
      q = p2.projectId;
    const reader = await pat(u, [read]),
      otherReader = await pat(u, [read]);
    const allow = (token, scope, ids) => authorize(pools[index++ % 2], token.secret, scope, ids);
    const deny = async (token, scope, ids, status = 403) => {
      for (const pool of pools) await assert.rejects(authorize(pool, token.secret, scope, ids), { status });
    };

    await t.test('resources, immutable keys, uniqueness, literal search and bounded pages', async () => {
      assert.deepEqual(await get(`/projects/${p}`), p1);
      assert.equal((await get(`/users/${u}`)).enabled, true);
      assert.equal((await get(`/teams/${a}`)).displayName, 'First team');
      assert.equal((await get('/users?q=OWNER')).items[0].userId, u);
      assert.equal((await get('/projects?q=_v2')).items[0].projectId, p);
      assert.equal((await get('/projects?q=%25')).items.length, 0);
      const first = await get('/teams?limit=1');
      const next = await get(`/teams?limit=1&cursor=${first.nextCursor}`);
      assert.notEqual(first.items[0].teamId, next.items[0].teamId);
      assert.equal(next.nextCursor, null);
      await call('GET', '/teams?limit=101', undefined, 400);
      await call('GET', '/users?limit=1&limit=2', undefined, 400);
      await call('GET', '/users?cursor=bad', undefined, 400);
      await call('GET', `/users/${randomUUID()}/teams`, undefined, 404);
      await call('PATCH', `/teams/${b}`, { displayName: 'Second renamed' });
      await call('PATCH', `/users/${u}`, { displayName: 'New owner' });
      await call('PATCH', `/users/${u}`, { enabled: 'true' }, 400);
      await call('PATCH', `/projects/${p}`, { projectId: q }, 400);
      await call('POST', '/projects', { projectId: p, slug: 'abc', displayName: 'Alias' }, 400);
      for (const value of ['a b', 'UP', 'é', 'a/b', '', 'a'.repeat(81)])
        await call('PATCH', `/projects/${p}`, { slug: value }, 400);
      await call('POST', '/projects', { slug: p1.slug, displayName: 'Alias' }, 409);
      await call('PATCH', `/projects/${q}`, { slug: p1.slug }, 409);
      // A database constraint, rather than a replica-local check, chooses one contender.
      const statuses = await Promise.all(
        servers.map(({ base }) =>
          fetch(base + '/projects', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + admin, 'content-type': 'application/json' },
            body: JSON.stringify({ slug: 'one-winner', displayName: 'Race' }),
          }).then(async (r) => {
            await r.text();
            return r.status;
          }),
        ),
      );
      assert.deepEqual(statuses.sort(), [201, 409]);
    });
    await t.test('only admin can manage; no token material on subsequent reads', async () => {
      assert.notEqual(reader.secret, otherReader.secret);
      const listed = (await get(`/users/${u}/tokens`)).items;
      assert.equal(listed.length, 2);
      assert.deepEqual(
        Object.keys(listed[0]).sort(),
        ['issuedAt', 'label', 'revokedAt', 'scopes', 'tokenId', 'userId'].sort(),
      );
      for (const [method, path, body] of [
        ['GET', '/users'],
        ['PATCH', `/users/${u}`, { enabled: false }],
        ['PUT', grant(p, 'members', u), { permissions: [read] }],
        ['POST', `/users/${u}/tokens`, { scopes: [read] }],
        ['DELETE', `/teams/${a}`],
      ])
        await call(method, path, body, 401, reader.secret);
      await call('POST', `/users/${u}/tokens`, { scopes: ['admin'] }, 400);
      await call('POST', `/users/${u}/tokens`, { scopes: [read], projectIds: [p] }, 400);
      await call('PUT', grant(p, 'members', u), { permissions: [] }, 400);
      await call('PUT', grant(p, 'members', randomUUID()), { permissions: [read] }, 404);
      await call('GET', '/tokens', undefined, 404);
      await deny({ secret: admin }, read, [p], 401);
      assert.deepEqual((await allow(reader, read)).projects, []);
      await deny(reader, read, [p]);
    });
    const membership = (team, user) => `/teams/${team}/members/${user}`;
    await t.test('only read grants and PAT scopes are issued; overlapping read sources survive removal', async () => {
      for (const values of [['logs:write'], [read, 'logs:write']]) {
        await call('POST', `/users/${u}/tokens`, { scopes: values }, 400);
        await call('PUT', grant(p, 'members', u), { permissions: values }, 400);
        await call('PUT', grant(p, 'teams', a), { permissions: values }, 400);
      }
      await put(grant(p, 'teams', a), { permissions: [read] });
      await put(grant(q, 'teams', a), { permissions: [read] });
      await deny(reader, read, [p, q]);
      await put(membership(a, u));
      assert.equal((await allow(reader, read, [p, q])).projects.length, 2);
      assert.equal((await get(`/users/${u}/teams`)).items[0].teamId, a);
      assert.equal((await get(`/teams/${a}/members`)).items[0].userId, u);
      assert.equal((await get(`/teams/${a}/projects`)).items.length, 2);
      assert.equal((await get(`/projects/${p}/teams`)).items[0].teamId, a);
      await put(membership(b, u));
      await put(grant(p, 'teams', b), { permissions: [read] });
      await put(grant(p, 'members', u), { permissions: [read] });
      const renamed = await call('PATCH', `/projects/${p}`, { slug: 'new-slug_v3', displayName: '重命名' });
      assert.deepEqual((await allow(reader, read, [p])).projects, [renamed]);
      assert.deepEqual((await get(`/users/${u}/memberships`)).items[0], { ...renamed, permissions: [read] });
      const sources = (await get(`/users/${u}/access/${p}`)).items;
      assert.deepEqual(
        sources
          .filter((s) => s.type === 'team')
          .map((s) => s.teamId)
          .sort(),
        [a, b].sort(),
      );
      assert.equal(sources.filter((s) => s.type === 'direct').length, 1);
      await del(membership(a, u));
      await deny(reader, read, [q]);
      await del(grant(p, 'members', u));
      await allow(reader, read, [p]);
      await del(`/teams/${b}`);
      await deny(reader, read, [p]);
      await put(grant(p, 'members', u), { permissions: [read] });
      await call('PATCH', `/users/${u}`, { enabled: false });
      await deny(reader, read, [p], 401);
      await deny(otherReader, read, [p], 401);
      await call('PATCH', `/users/${u}`, { enabled: true });
      await del(`/users/${u}/tokens/${otherReader.tokenId}`);
      await del(`/users/${u}/tokens/${otherReader.tokenId}`);
      await deny(otherReader, read, [p], 401);
      await allow(reader, read, [p]);
    });
    await t.test(
      'project keys write only to their project, rotate independently and never confer read or admin access',
      async () => {
        const path = `/projects/${p}/keys`;
        await call('POST', path, { name: ' ' }, 400);
        await call('POST', path, { name: 'x', projectId: q }, 400);
        await call('POST', path, { name: 'x' }, 401, reader.secret);
        const first = await create(path, { name: 'frontend' }),
          second = await create(path, { name: 'backend' });
        assert.match(first.key, /^llpk_[A-Za-z0-9_-]{43}$/);
        assert.notEqual(first.key, second.key);
        assert.equal(first.projectId, p);
        assert.deepEqual(
          Object.keys(first).sort(),
          ['keyId', 'projectId', 'name', 'key', 'issuedAt', 'revokedAt'].sort(),
        );
        const listed = await get(path + '?limit=1');
        assert.deepEqual(
          Object.keys(listed.items[0]).sort(),
          ['keyId', 'projectId', 'name', 'issuedAt', 'revokedAt'].sort(),
        );
        assert.notEqual((await get(path + `?cursor=${listed.nextCursor}`)).items[0].keyId, listed.items[0].keyId);
        assert.deepEqual((await get(`/projects/${q}/keys`)).items, []);
        const batch = {
          projectId: p,
          events: [{ id: 'key-check', level: 'LOG', timestamp: Date.now(), message: 'synthetic' }],
        };
        const logs = '/api/v1/logs';
        for (const token of [reader.secret, admin, 'llpk_' + 'a'.repeat(43)])
          await call('POST', logs, batch, 401, token);
        await call('POST', logs, { ...batch, service: 'legacy' }, 400, first.key);
        await call('POST', logs, { ...batch, projectId: q }, 403, first.key);
        assert.deepEqual((await call('POST', logs, batch, 200, first.key)).acceptedEventIds, ['key-check']);
        await call('GET', path, undefined, 401, first.key);
        await call('GET', '/api/v1/explorer/projects', undefined, 401, first.key);
        assert.equal(
          (await call('POST', '/api/v1/explorer/rows', { query: { projectIds: [p] } }, 200, reader.secret)).items[0]
            .message,
          'synthetic',
        );
        await call('PATCH', `/users/${u}`, { enabled: false });
        await call('POST', logs, batch, 200, first.key);
        await call('DELETE', `/projects/${q}/keys/${first.keyId}`, undefined, 404);
        await del(path + '/' + first.keyId);
        await del(path + '/' + first.keyId);
        for (let i = 0; i < 2; i++) await call('POST', logs, batch, 401, first.key);
        await call('POST', logs, batch, 200, second.key);
        assert.ok((await get(path)).items.find((row) => row.keyId === first.keyId).revokedAt);
      },
    );
  },
);
