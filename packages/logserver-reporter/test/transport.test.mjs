import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createLoglineServerReporter, createLoglineServerTransport } from 'logserver-reporter';

const options = {
  baseUrl: 'https://logs.example.test/proxy',
  token: 'synthetic-write-only',
  projectId: '00000000-0000-4000-8000-000000000001',
  service: 'catalog',
};
const batch = [
  { id: 'a', level: 'WARN', timestamp: 1700000000000, message: 'Synthetic example' },
  { id: 'b', level: 'LOG', timestamp: 1700000000001, message: 'Another example' },
];
const ctx = { signal: new AbortController().signal };
const partial = { acceptedEventIds: ['a'], retryableEventIds: ['b'], rejectedEventIds: [], retryAfterMs: 1500 };

test('publishes the same factories for ESM and CommonJS without sending on construction', () => {
  const cjs = createRequire(import.meta.url)('logserver-reporter');
  assert.equal(typeof cjs.createLoglineServerReporter, 'function');
  const reporter = createLoglineServerReporter({ ...options, fetch: () => assert.fail('Unexpected fetch') });
  reporter.dispose();
});

test('preserves base paths and stable IDs, rotates the credential per attempt and forwards cancellation', async () => {
  let n = 0;
  const transport = createLoglineServerTransport({
    ...options,
    token: () => `test-${++n}`,
    fetch: async (url, init) => {
      assert.equal(url, 'https://logs.example.test/proxy/api/v1/logs');
      assert.equal(init.headers.authorization, `Bearer test-${n}`);
      assert.equal(init.signal, ctx.signal);
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.deepEqual(JSON.parse(init.body), { projectId: options.projectId, service: 'catalog', events: batch });
      return Response.json(partial);
    },
  });
  assert.deepEqual(await transport.send(batch, ctx), partial);
  await transport.send(batch, ctx);
  assert.equal(n, 2);
});

test('retries transient responses, honors cooldowns and permanently rejects permanent errors', async () => {
  for (const status of [401, 403, 413, 422, 408, 425, 429, 500, 503]) {
    const transient = [408, 425, 429, 500, 503].includes(status);
    const transport = createLoglineServerTransport({
      ...options,
      fetch: async () => new Response(null, { status, headers: { 'Retry-After': '2' } }),
    });
    assert.deepEqual(await transport.send(batch, ctx), {
      acceptedEventIds: [],
      retryableEventIds: transient ? ['a', 'b'] : [],
      rejectedEventIds: transient ? [] : ['a', 'b'],
      retryAfterMs: 2000,
    });
  }
});

test('rejects invalid project or service identities before sending', () => {
  for (const projectId of ['billing', '', '00000000-0000-4000-8000'])
    assert.throws(() => createLoglineServerTransport({ ...options, projectId }), TypeError);
  for (const service of ['', '   ', 'example\0service', '测'.repeat(43)])
    assert.throws(() => createLoglineServerTransport({ ...options, service }), TypeError);
  assert.doesNotThrow(() => createLoglineServerTransport({ ...options, service: '测'.repeat(42) }));
});

test('does not send after cancellation during an asynchronous credential refresh', async () => {
  const controller = new AbortController();
  let resolveToken;
  const transport = createLoglineServerTransport({
    ...options,
    token: () =>
      new Promise((resolve) => {
        resolveToken = resolve;
      }),
    fetch: async () => assert.fail('Unexpected fetch after cancellation'),
  });
  const sent = transport.send(batch, { signal: controller.signal });
  controller.abort();
  resolveToken('rotated-synthetic');
  await assert.rejects(sent, { name: 'AbortError' });
});

test('retains acknowledged IDs in a quota-limited batch', async () => {
  const transport = createLoglineServerTransport({
    ...options,
    fetch: async () => Response.json(partial, { status: 429, headers: { 'Retry-After': '2' } }),
  });
  assert.deepEqual(await transport.send(batch, ctx), { ...partial, retryAfterMs: 2000 });
});

test('fails closed on an invalid acknowledgement; never treats HTTP success alone as delivery', async () => {
  for (const body of [
    'not json',
    '{}',
    JSON.stringify({ ...partial, retryAfterMs: -1 }),
    ' '.repeat(1024 * 1024 + 1),
  ]) {
    const transport = createLoglineServerTransport({ ...options, fetch: async () => new Response(body) });
    await assert.rejects(transport.send(batch, ctx));
  }
});

test('refuses credential-bearing and insecure URLs, including attempts to put a token in the URL', () => {
  for (const baseUrl of [
    'http://logs.example.test',
    'https://a:b@logs.example.test',
    'https://logs.example.test/?token=example',
    'ftp://localhost',
  ])
    assert.throws(() => createLoglineServerTransport({ ...options, baseUrl }), TypeError);
  assert.doesNotThrow(() => createLoglineServerTransport({ ...options, baseUrl: 'http://[::1]:4318' }));
});
