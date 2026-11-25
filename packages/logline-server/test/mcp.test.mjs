import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { handleMcp } from '../src/mcp.mjs';

const version = '2025-06-18';
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: version, clientInfo: { name: 'synthetic-client', version: '1' }, capabilities: {} },
};
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 2, method, params });
const call = (name, args = {}) => rpc('tools/call', { name: `logline_server_${name}`, arguments: args });

test('MCP protocol negotiation, read-only inventory, notifications and invalid messages', async () => {
  const db = { query: async () => ({ rows: [{ userId: 'synthetic', allowed: true }] }) };
  const token = `llpat_${randomBytes(32).toString('base64url')}`;
  async function dispatch(body, headers = {}, auth = token) {
    let response;
    assert.equal(
      await handleMcp({
        db,
        url: new URL('http://localhost/mcp'),
        token: auth,
        req: { method: 'POST', headers },
        body,
        send: (status, value) => {
          response = { status, value };
        },
      }),
      true,
    );
    return response;
  }
  assert.equal((await dispatch(initialize)).value.result.protocolVersion, version);
  const listing = (await dispatch(rpc('tools/list'))).value.result.tools;
  assert.deepEqual(
    listing.map((t) => t.name),
    ['projects', 'selectors', 'fields', 'rows', 'series', 'groups', 'detail', 'context'].map(
      (name) => `logline_server_${name}`,
    ),
  );
  assert.ok(listing.every((t) => t.annotations.readOnlyHint && t.inputSchema.type === 'object'));
  assert.deepEqual(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), {
    status: 202,
    value: undefined,
  });
  assert.equal((await dispatch([initialize])).status, 400);
  assert.equal((await dispatch(rpc('ping'), { 'mcp-protocol-version': 'other' })).status, 400);
  assert.equal((await dispatch(initialize, { origin: 'https://example.invalid' })).status, 403);
  assert.equal((await dispatch(rpc('unknown'))).value.error.code, -32601);
  for (const body of [
    call('delete'),
    rpc('tools/call', { name: 'logline_projects' }),
    call('rows', { token: 'override' }),
    call('detail', { eventId: 'e' }),
    call('context', null),
  ])
    assert.equal((await dispatch(body)).value.error.code, -32602);
  for (const body of [initialize, rpc('tools/list'), { jsonrpc: '2.0', method: 'notifications/initialized' }])
    await assert.rejects(() => dispatch(body, {}, ''), { status: 401 });
});

test(
  'two stateless MCP replicas use the same live grants, filters and event identities as HTTP Explorer',
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const { startServer } = await import('../src/server.mjs');
    const schema = 'mcp_' + randomUUID().replaceAll('-', '');
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    const admin = randomBytes(32).toString('base64url');
    const env = {
      ...process.env,
      DATABASE_URL: url.toString(),
      LOGLINE_ADMIN_TOKEN: admin,
      LOGLINE_MCP_ENABLED: 'true',
    };
    const replicas = [];
    t.after(async () => {
      try {
        await Promise.all(replicas.map((x) => x.close()));
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    });
    for (let n = 0; n < 2; n++) replicas.push(await startServer({ env, port: 0, host: '127.0.0.1' }));
    async function request(path, { method = 'POST', token = admin, body, replica = 0, status = 200 } = {}) {
      const res = await fetch(`http://127.0.0.1:${replicas[replica].server.address().port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(res.status, status, `${method} ${path} status`);
      const text = await res.text();
      return text ? JSON.parse(text) : undefined;
    }
    const manage = (path, options) => request('/api/v1/admin/' + path, options);
    const { userId } = await manage('users', { status: 201, body: { displayName: 'Synthetic reader' } });
    const { teamId } = await manage('teams', { status: 201, body: { displayName: 'Synthetic support' } });
    const { projectId } = await manage('projects', {
      status: 201,
      body: { slug: 'test-project', displayName: 'Test project' },
    });
    const { secret: pat, tokenId } = await manage(`users/${userId}/tokens`, {
      status: 201,
      body: { scopes: ['logs:read'] },
    });
    const { key: ingestKey } = await manage(`projects/${projectId}/keys`, {
      status: 201,
      body: { name: 'Synthetic uploader' },
    });
    const mcp = (body, options = {}) => request('/mcp', { token: pat, body, replica: 1, ...options });
    const invoke = async (name, args) => JSON.parse((await mcp(call(name, args))).result.content[0].text);
    const query = {
      projectIds: [projectId],
      range: { last: '1h' },
      where: {
        and: [
          { field: 'level', op: 'eq', value: 'ERROR' },
          { field: 'message', op: 'icontains', value: 'timeout' },
        ],
      },
    };
    await mcp(initialize, { token: admin, status: 401 });
    await mcp(rpc('tools/list'), { token: ingestKey, status: 401 });
    assert.deepEqual((await invoke('projects')).items, []);
    await mcp(call('rows', { query }), { status: 403 });
    await manage(`projects/${projectId}/teams/${teamId}`, {
      method: 'PUT',
      status: 204,
      body: { permissions: ['logs:read'] },
    });
    await manage(`teams/${teamId}/members/${userId}`, { method: 'PUT', status: 204 });
    assert.equal((await invoke('projects')).items[0].projectId, projectId);
    const timestamp = Date.now() - 1000;
    const events = ['LOG', 'ERROR'].map((level, i) => ({
      id: 'e' + i,
      timestamp: timestamp + i,
      message: i ? 'Upstream Timeout' : 'Started',
      fields: { latency: 4 + i },
      context: { environment: 'test', traceId: 'synthetic-trace', sessionId: 'synthetic-session' },
      level,
    }));
    await request('/api/v1/logs', { token: ingestKey, body: { projectId, events } });
    const absolute = {
      ...query,
      range: { start: new Date(timestamp - 60000).toISOString(), end: new Date(timestamp + 60000).toISOString() },
    };
    const args = { query: absolute, columns: ['eventId', 'message'], limit: 5 };
    const rows = await invoke('rows', args);
    assert.deepEqual(rows, await request('/api/v1/explorer/rows', { token: pat, body: args }));
    assert.equal(rows.items.length, 1);
    assert.equal(rows.items[0].message, 'Upstream Timeout');
    assert.deepEqual((await invoke('selectors', { query })).items, [{ projectId, environment: 'test' }]);
    assert.ok((await invoke('fields', { query })).items.length > 0);
    for (const name of ['series', 'groups'])
      assert.ok(
        (await invoke(name, { query, groupBy: ['environment'], metric: { op: 'count' } })).items.some(
          (row) => row.value === 1,
        ),
      );
    const key = { projectId, eventId: 'e1' };
    assert.equal((await invoke('detail', key)).item.message, 'Upstream Timeout');
    for (const mode of ['trace', 'session', 'nearby'])
      assert.ok((await invoke('context', { ...key, mode })).items.some((row) => row.message === 'Started'));
    assert.equal(
      (await mcp(call('rows', { query: { projectIds: [projectId], range: { last: '300d' } } }))).result.isError,
      true,
    );
    assert.equal((await mcp(call('detail', { projectId, eventId: 'absent' }))).result.isError, true);
    const padded = Array.from({ length: 10 }, (_, i) => ({
      id: `large-${i}`,
      level: 'LOG',
      timestamp,
      message: 'x'.repeat(60000),
      context: { environment: 'synthetic-padding' },
    }));
    await request('/api/v1/logs', { token: ingestKey, body: { projectId, events: padded } });
    const filter = { projectIds: [projectId], where: { field: 'environment', op: 'eq', value: 'synthetic-padding' } };
    const oversized = (await mcp(call('rows', { query: filter }))).result;
    assert.equal(oversized.isError, true);
    assert.match(oversized.content[0].text, /512 KiB/);
    assert.equal((await invoke('rows', { query: filter, columns: ['eventId'] })).items.length, 10);
    await manage(`teams/${teamId}/members/${userId}`, { method: 'DELETE', status: 204 });
    assert.deepEqual((await invoke('projects')).items, []);
    for (const name of ['rows', 'selectors', 'fields', 'groups', 'series', 'detail', 'context'])
      await mcp(call(name, ['detail', 'context'].includes(name) ? key : { query }), { status: 403 });
    await manage(`users/${userId}/tokens/${tokenId}`, { method: 'DELETE', status: 204 });
    await mcp(rpc('tools/list'), { status: 401 });
  },
);
