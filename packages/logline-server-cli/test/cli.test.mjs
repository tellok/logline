import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const token = 'synthetic-read-token';
const projectId = '00000000-0000-4000-8000-000000000001';
const event = {
  eventId: 'synthetic-event',
  projectId,
  timestamp: Date.UTC(2026, 0, 15, 12),
  level: 'ERROR',
  message: 'Checkout timed out\nRetry scheduled\x1b[2J',
  context: { environment: 'staging', traceId: 'synthetic-trace' },
  fields: { durationMs: 500 },
};

function run(args, env = {}, input) {
  const childEnv = { ...process.env, LOGLINE_URL: '', LOGLINE_AUTH_TOKEN: '', ...env };
  delete childEnv.FORCE_COLOR;
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [bin, ...args],
      { env: childEnv, encoding: 'utf8' },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin.end(input);
  });
}

async function fixture(t, response, status = 200, headers = {}) {
  const requests = [];
  const server = createServer(async (request, reply) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const data = Buffer.concat(chunks).toString('utf8');
    requests.push({
      method: request.method,
      url: request.url,
      auth: request.headers.authorization,
      contentType: request.headers['content-type'],
      body: data ? JSON.parse(data) : undefined,
    });
    reply.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    reply.end(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  return {
    requests,
    env: { LOGLINE_URL: `http://127.0.0.1:${server.address().port}/deployment/`, LOGLINE_AUTH_TOKEN: token },
  };
}

test('log list reads from a prefixed deployment and prints readable, safe logs and a continuation', async (t) => {
  const { env, requests } = await fixture(
    t,
    JSON.stringify({
      items: [event],
      nextCursor: 'synthetic-cursor',
      limited: true,
      range: { start: '2026-01-15T11:00:00Z', end: '2026-01-15T12:00:00Z' },
    }),
  );
  const result = await run(
    [
      'log',
      'list',
      '-p',
      projectId,
      '-e',
      'staging',
      '-e',
      'test',
      '-t',
      '2h',
      '-l',
      'error',
      '-q',
      'checkout',
      '--trace',
      'synthetic-trace',
      '-s',
      'oldest',
      '-n',
      '20',
      '--cursor',
      'previous-cursor',
    ],
    env,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^2026-01-15T12:00:00.000Z  ERROR  Checkout timed out\n    Retry scheduled\\u001b\[2J/);
  assert.match(result.stdout, /event=synthetic-event  environment="staging"  traceId="synthetic-trace"/);
  assert.match(result.stdout, /Next page  --cursor synthetic-cursor/);
  assert.doesNotMatch(result.stdout, /durationMs/);
  assert.deepEqual(requests, [
    {
      method: 'POST',
      url: '/deployment/api/v1/explorer/rows',
      auth: `Bearer ${token}`,
      contentType: 'application/json',
      body: {
        query: {
          projectIds: [projectId],
          environments: ['staging', 'test'],
          range: { last: '2h' },
          where: {
            and: [
              { field: 'level', op: 'eq', value: 'ERROR' },
              { field: 'message', op: 'icontains', value: 'checkout' },
              { field: 'traceId', op: 'eq', value: 'synthetic-trace' },
            ],
          },
        },
        limit: 20,
        sort: 'asc',
        cursor: 'previous-cursor',
      },
    },
  ]);
});

test('log view prints structured details; --raw and --json preserve the original response', async (t) => {
  const body = ` {\n "item" : ${JSON.stringify(event)}\n }  `;
  const { env, requests } = await fixture(t, body);
  const args = ['log', 'view', projectId, event.eventId];
  const human = await run(args, env);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /fields  \{\n {6}"durationMs": 500/);
  for (const flag of ['--raw', '--json']) {
    const raw = await run([...args, flag, '--token', 'synthetic-override', '--url', env.LOGLINE_URL], {
      ...env,
      LOGLINE_URL: 'https://unused.example.test',
    });
    assert.deepEqual(raw, { code: 0, stdout: body, stderr: '' });
  }
  assert.deepEqual(
    requests.map(({ url, auth, body }) => ({ url, auth, body })),
    [
      {
        url: '/deployment/api/v1/explorer/detail',
        auth: `Bearer ${token}`,
        body: { projectId, eventId: event.eventId },
      },
      ...Array.from({ length: 2 }, () => ({
        url: '/deployment/api/v1/explorer/detail',
        auth: 'Bearer synthetic-override',
        body: { projectId, eventId: event.eventId },
      })),
    ],
  );
});

test('project listing and generic Explorer queries use the API method and payload', async (t) => {
  const { env, requests } = await fixture(t, '{"items":[]}');
  const projects = await run(['project', 'list', '--limit', '10', '--offset', '20'], env);
  assert.deepEqual(JSON.parse(projects.stdout), { items: [] });
  const groups = await run(['api', '/api/v1/explorer/groups', '--data', '@-'], env, '{"groupBy":["level"]}');
  assert.equal(groups.code, 0, groups.stderr);
  const empty = await run(['log', 'context', projectId, event.eventId, '--mode', 'trace'], env);
  assert.deepEqual(empty, { code: 0, stdout: 'No logs found.\n', stderr: '' });
  assert.deepEqual(
    requests.map(({ method, url, body }) => ({ method, url, body })),
    [
      { method: 'GET', url: '/deployment/api/v1/explorer/projects?limit=10&offset=20', body: undefined },
      { method: 'POST', url: '/deployment/api/v1/explorer/groups', body: { groupBy: ['level'] } },
      {
        method: 'POST',
        url: '/deployment/api/v1/explorer/context',
        body: { projectId, eventId: event.eventId, mode: 'trace' },
      },
    ],
  );
});

test('bad input fails without a request, and an API error stays on stderr even in raw mode', async (t) => {
  const { env, requests } = await fixture(
    t,
    JSON.stringify({ error: { code: 'unauthorized', message: `Rejected ${token}` } }),
    401,
  );
  for (const [args, error] of [
    [['log', 'list', '--limit', '101'], /--limit must be an integer/],
    [['api', '../admin/projects'], /read-only Explorer path/],
    [['api', 'views', '--data', '{}'], /POST query/],
    [['log', 'list', '--url', 'http://logs.example.test'], /HTTPS deployment URL/],
  ]) {
    const result = await run(args, env);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, error);
  }
  assert.equal(requests.length, 0);
  const result = await run(['log', 'list', '--raw'], env);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /HTTP 401  unauthorized Rejected \[redacted\]/);
  assert.doesNotMatch(result.stderr, new RegExp(token));
});

test('redirects do not forward the token to another origin', async (t) => {
  const destination = await fixture(t, '{}');
  const { env, requests } = await fixture(t, '', 302, { Location: destination.env.LOGLINE_URL });
  const result = await run(['project', 'list'], env);
  assert.equal(result.code, 1);
  assert.equal(requests.length, 1);
  assert.equal(destination.requests.length, 0);
});
