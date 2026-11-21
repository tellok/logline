import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { startServer } from '../src/server.mjs';
import { test } from 'node:test';
import pg from 'pg';
import { authorize, bearer, requireAdmin } from '../src/auth.mjs';

const admin = randomBytes(32).toString('hex');
const read = 'logs:read',
  write = 'logs:write';
const both = [read, write];

test('bootstrap and PAT credentials occupy separate namespaces and fail closed', async () => {
  assert.equal(bearer({ headers: { authorization: 'Bearer a, Bearer b' } }), undefined);
  assert.throws(() => requireAdmin('short', 'short'), { status: 401 });
  assert.throws(() => requireAdmin(undefined, undefined), { status: 401 });
  assert.throws(() => requireAdmin('llpat_' + admin, 'llpat_' + admin), { status: 401 });
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
    const { userId: svc } = await create(users, { displayName: 'Service' });
    const { teamId: a } = await create(teams, { displayName: 'First team' });
    const { teamId: b } = await create(teams, { displayName: 'Second team' });
    const p1 = await create(projects, { slug: 'payments-api_v2', displayName: '支付服务' });
    const p2 = await create(projects, { slug: 'billing', displayName: '支付服务' });
    const p = p1.projectId,
      q = p2.projectId;
    const reader = await pat(u, [read]),
      writer = await pat(u, [write]),
      uploader = await pat(svc, [write]);
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
      assert.notEqual(reader.secret, writer.secret);
      const listed = (await get(`/users/${u}/tokens`)).items;
      assert.equal(listed.length, 2);
      assert.deepEqual(
        Object.keys(listed[0]).sort(),
        ['issuedAt', 'label', 'revokedAt', 'scopes', 'tokenId', 'userId'].sort(),
      );
      for (const [method, path, body] of [
        ['GET', '/users'],
        ['PATCH', `/users/${u}`, { enabled: false }],
        ['PUT', grant(p, 'members', u), { permissions: both }],
        ['POST', `/users/${u}/tokens`, { scopes: both }],
        ['DELETE', `/teams/${a}`],
      ])
        await call(method, path, body, 401, reader.secret);
      await call('POST', `/users/${u}/tokens`, { scopes: ['admin'] }, 400);
      await call('POST', `/users/${u}/tokens`, { scopes: [read], projectIds: [p] }, 400);
      await call('PUT', grant(p, 'members', u), { permissions: [] }, 400);
      await call('PUT', grant(p, 'members', randomUUID()), { permissions: both }, 404);
      await call('GET', '/tokens', undefined, 404);
      await deny({ secret: admin }, read, [p], 401);
      assert.deepEqual((await allow(reader, read)).projects, []);
      await deny(reader, read, [p]);
    });
    const membership = (team, user) => `/teams/${team}/members/${user}`;
    await t.test(
      'scope intersects the current union of direct and team grants; overlapping sources survive rename/removal',
      async () => {
        await put(grant(p, 'teams', a), { permissions: both });
        await put(grant(q, 'teams', a), { permissions: [read] });
        await deny(reader, read, [p, q]);
        await put(membership(a, u));
        await put(membership(a, u));
        assert.equal((await allow(reader, read, [p, q])).projects.length, 2);
        await deny(reader, write, [p]);
        await deny(writer, write, [q]);
        const batch = {
          projectId: p,
          service: 'checkout',
          events: [{ id: 'rename-fixture', timestamp: Date.now(), level: 'LOG', message: 'before rename' }],
        };
        await call('POST', '/api/v1/logs', batch, 403, reader.secret);
        await call('POST', '/api/v1/logs', batch, 401, admin);
        assert.deepEqual((await call('POST', '/api/v1/logs', batch, 200, writer.secret)).acceptedEventIds, [
          'rename-fixture',
        ]);
        await allow(writer, write, [p]);
        assert.equal((await get(`/users/${u}/teams`)).items[0].teamId, a);
        assert.equal((await get(`/teams/${a}/members`)).items[0].userId, u);
        assert.equal((await get(`/teams/${a}/projects`)).items.length, 2);
        assert.equal((await get(`/projects/${p}/teams`)).items[0].teamId, a);
        assert.equal((await get(`/users/${u}/memberships`)).items.length, 0);
        await put(membership(b, u));
        await put(grant(p, 'teams', b), { permissions: [read] });
        await put(grant(p, 'members', u), { permissions: [write] });
        const renamed = await call('PATCH', `/projects/${p}`, { slug: 'new-slug_v3', displayName: '重命名' });
        assert.equal(renamed.projectId, p);
        assert.deepEqual((await allow(reader, read, [p])).projects, [renamed]);
        const query = { projectIds: [p] };
        const rows = await call('POST', '/api/v1/explorer/rows', { query }, 200, reader.secret);
        assert.equal(rows.items[0].message, 'before rename');
        assert.equal(
          (await call('POST', '/api/v1/explorer/export', { query, format: 'jsonl' }, 200, reader.secret)).rowCount,
          1,
        );
        assert.equal((await get(`/projects/${p}/members`)).items[0].userId, u);
        assert.deepEqual((await get(`/users/${u}/memberships`)).items[0], { ...renamed, permissions: [write] });
        const sources = (await get(`/users/${u}/access/${p}`)).items;
        assert.deepEqual(
          sources
            .filter((s) => s.type === 'team')
            .map((s) => s.teamId)
            .sort(),
          [a, b].sort(),
        );
        assert.equal(sources.filter((s) => s.type === 'direct').length, 1);
        assert.deepEqual((await get(`/users/${u}/access`)).items.find((row) => row.projectId === p).permissions, both);
        await del(membership(a, u));
        await deny(reader, read, [q]);
        await allow(reader, read, [p]);
        await allow(writer, write, [p]);
        await put(grant(p, 'teams', b), { permissions: [write] });
        await deny(reader, read, [p]);
        await put(grant(p, 'members', u), { permissions: both });
        await allow(reader, read, [p]);
        await del(grant(p, 'members', u));
        await deny(reader, read, [p]);
        await allow(writer, write, [p]);
        await del(grant(p, 'teams', b));
        await deny(writer, write, [p]);
        await put(membership(a, u));
        await allow(reader, read, [p, q]);
        await del(`/teams/${a}`);
        await deny(reader, read, [p, q]);
        assert.deepEqual((await allow(reader, read)).projects, []);
        assert.deepEqual((await call('GET', '/api/v1/explorer/projects', undefined, 200, reader.secret)).items, []);
        await call('POST', '/api/v1/explorer/rows', { query }, 403, reader.secret);
        await call('POST', '/api/v1/explorer/export', { query, format: 'jsonl' }, 403, reader.secret);
      },
    );
    await t.test('service-user isolation, disable/enable all PATs, independent revocation', async () => {
      await put(grant(q, 'members', svc), { permissions: [write] });
      await allow(uploader, write, [q]);
      await deny(uploader, write, [p]);
      await deny(uploader, read, [q]);
      const batch = {
        projectId: q,
        service: 'service',
        events: [{ id: 'service-fixture', timestamp: Date.now(), level: 'LOG', message: 'service event' }],
      };
      await call('POST', '/api/v1/logs', batch, 200, uploader.secret);
      await call('POST', '/api/v1/logs', { ...batch, projectId: p }, 403, uploader.secret);
      await put(grant(p, 'members', u), { permissions: both });
      await allow(reader, read, [p]);
      await allow(writer, write, [p]);
      await call('PATCH', `/users/${u}`, { enabled: false });
      await deny(reader, read, [p], 401);
      await deny(writer, write, [p], 401);
      await call('PATCH', `/users/${u}`, { enabled: true });
      await del(`/users/${u}/tokens/${reader.tokenId}`);
      await del(`/users/${u}/tokens/${reader.tokenId}`);
      await deny(reader, read, [p], 401);
      await allow(writer, write, [p]);
      assert.ok((await get(`/users/${u}/tokens`)).items.find((t) => t.tokenId === reader.tokenId).revokedAt);
      await call('DELETE', `/users/${svc}/tokens/${writer.tokenId}`, undefined, 404);
    });
  },
);
