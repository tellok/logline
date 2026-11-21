import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createLoglineServerReporter, createLoglineServerTransport } from 'logserver-reporter';

const key = `llpk_${'a'.repeat(40)}A-_`;
const projectId = '00000000-0000-4000-8000-000000000001';
const dsn = `https://${key}@logs.example.test/proxy/${projectId}`;
const options = { dsn };
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

test('preserves proxy prefix and IDs, sending the key only in Authorization', async () => {
  let calls = 0;
  const transport = createLoglineServerTransport({
    ...options,
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://logs.example.test/proxy/api/v1/logs');
      assert.deepEqual(init.headers, { authorization: `Bearer ${key}`, 'content-type': 'application/json' });
      assert.equal(init.signal, ctx.signal);
      assert.equal(init.redirect, 'error');
      assert.equal(init.credentials, 'omit');
      assert.deepEqual(JSON.parse(init.body), { projectId, events: batch });
      return Response.json(partial);
    },
  });
  assert.deepEqual(await transport.send(batch, ctx), partial);
  assert.equal(calls, 1);
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

test('does not send an already cancelled batch', async () => {
  const transport = createLoglineServerTransport({ ...options, fetch: async () => assert.fail('Unexpected fetch') });
  await assert.rejects(transport.send(batch, { signal: AbortSignal.abort() }), { name: 'AbortError' });
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

test('rejects malformed DSNs before sending, without leaking keys in parser diagnostics', () => {
  for (const invalid of [
    undefined,
    null,
    '',
    'not a url',
    dsn.replace('https:', 'http:'),
    dsn.replace('https:', 'ftp:'),
    dsn.replace(key, ''),
    dsn.replace(key, 'llpat_' + 'b'.repeat(43)),
    dsn.replace(key, key.slice(0, -1)),
    dsn.replace(key, key + ':'),
    dsn.replace(key, key + ':password'),
    dsn.replace(projectId, 'billing'),
    dsn + '?',
    dsn + '#',
    dsn + '?k=' + key,
    dsn + '#fragment',
    dsn + '/',
    dsn.replace('logs.example.test', 'local host'),
    dsn.replace('logs.example.test', 'logs.example.test:bad'),
    dsn.replace('/proxy/', `/${key}/`),
    dsn.replace('logs.example.test', key + '.invalid'),
  ]) {
    assert.throws(
      () => createLoglineServerTransport({ dsn: invalid }),
      (error) => error instanceof TypeError && !error.message.includes(key) && !JSON.stringify(error).includes(key),
    );
  }
});

test('accepts only loopback deployments over HTTP and preserves deployment prefixes', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const transport = createLoglineServerTransport({
      dsn: `http://${key}@${host}:4318/${projectId}`,
      fetch: async (url) => {
        assert.equal(url, `http://${host}:4318/api/v1/logs`);
        return Response.json(partial);
      },
    });
    await transport.send(batch, ctx);
  }
});

test('does not surface echoed credentials in fetch or response parsing errors', async () => {
  for (const fetch of [
    () => {
      throw new Error(key);
    },
    () => new Response(key),
  ]) {
    const transport = createLoglineServerTransport({ dsn, fetch });
    await assert.rejects(
      transport.send(batch, ctx),
      (error) => error instanceof Error && !error.stack.includes(key) && !error.cause,
    );
  }
});
