import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createIndexedDBLoggingPlugin } from '../indexeddb';
import { configureLogline, ERROR, LOG, resetLoglineConfig } from '../../index';
import {
  createReportingLoggingPlugin,
  type ReportingOptions,
  type ReportingEvent,
  type ReportingSendResult,
} from './index';

// The production logger is silent under Vitest. Exercise its real dispatch path.
vi.mock('../../core/env', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTestEnv: () => false,
}));

type Batch = readonly ReportingEvent[];
type Result = ReportingSendResult;
interface Request {
  batch: Batch;
  signal: AbortSignal;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
}
const ids = (batch: Batch) => batch.map(({ id }) => id);
const accept = (request: Request) =>
  request.resolve({ acceptedEventIds: ids(request.batch), retryableEventIds: [], rejectedEventIds: [] });
const advance = (ms = 1) => vi.advanceTimersByTimeAsync(ms);
const plugins = new Set<ReturnType<typeof createReportingLoggingPlugin>>();

/** Model a transport whose independent network responses can arrive in any order. */
function destination(options: Omit<ReportingOptions, 'transport'> = {}) {
  const requests: Request[] = [];
  const plugin = createReportingLoggingPlugin({
    maxBatchEvents: 2,
    flushIntervalMs: 1000,
    maxConcurrentBatches: 1,
    requestTimeoutMs: 5000,
    retryBaseMs: 100,
    retryMaxMs: 100,
    ...options,
    transport: {
      name: 'synthetic',
      send: (batch, { signal }) => new Promise((resolve, reject) => requests.push({ batch, signal, resolve, reject })),
    },
  });
  plugins.add(plugin);
  return { plugin, requests };
}
function emit(count: number, prefix = 'event') {
  for (let i = 0; i < count; i++) LOG(`${prefix}-${i}`);
}

describe('reporting through ordinary logger dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
  });
  afterEach(() => {
    for (const plugin of plugins) plugin.dispose();
    plugins.clear();
    resetLoglineConfig();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('B and C acknowledge before A; only the retryable part of A returns, without blocking D', async () => {
    const { plugin, requests } = destination({ maxConcurrentBatches: 2 });
    configureLogline({ plugins: [plugin] });
    emit(6);
    expect(requests).toHaveLength(0);
    await advance();
    expect(requests.map((r) => r.batch.length)).toEqual([2, 2]);
    const [a, b] = requests;
    accept(b);
    await advance();
    const c = requests[2];
    expect(c.batch).toHaveLength(2);
    expect(new Set([...ids(a.batch), ...ids(b.batch), ...ids(c.batch)]).size).toBe(6);
    accept(c);
    await advance();
    expect(plugin.getMetrics()).toMatchObject({ accepted: 4, inFlight: 2 });
    a.resolve({ acceptedEventIds: [a.batch[0].id], retryableEventIds: [a.batch[1].id], rejectedEventIds: [] });
    await advance();
    emit(2, 'later');
    await advance();
    const d = requests[3];
    expect(d.batch).toHaveLength(2);
    expect(new Set(requests.flatMap((r) => ids(r.batch))).size).toBe(8);
    await advance(101);
    expect(requests).toHaveLength(5);
    expect(requests[4].batch).toEqual([a.batch[1]]);
    accept(requests[4]);
    accept(d);
    await advance();
    expect(plugin.getMetrics()).toMatchObject({ accepted: 8, retried: 1, queued: 0, inFlight: 0, bytes: 0 });
  });

  test('a flush snapshots outstanding records and does not merge its backlog into one request', async () => {
    const { plugin, requests } = destination({ maxConcurrentBatches: 2 });
    configureLogline({ plugins: [plugin] });
    emit(5);
    const flush = plugin.flush({ timeout: 500 });
    expect(requests).toHaveLength(0);
    await advance();
    expect(requests.map((r) => r.batch.length)).toEqual([2, 2]);
    accept(requests[1]);
    await advance();
    expect(requests[2].batch).toHaveLength(1);
    emit(2, 'outside-cutoff');
    accept(requests[2]);
    await advance();
    expect(requests[3].batch).toHaveLength(2);
    accept(requests[0]);
    await advance();
    await expect(flush).resolves.toMatchObject({ accepted: 5, remaining: 0, timedOut: false });
    const timed = plugin.flush({ timeout: 10 });
    await advance(10);
    await expect(timed).resolves.toMatchObject({ accepted: 0, remaining: 2, timedOut: true });
    expect(requests[3].signal.aborted).toBe(false);
    accept(requests[3]);
    await advance();
    expect(plugin.getMetrics().accepted).toBe(7);
  });

  test('small batches respect the interval and a full batch is scheduled, never sent inline', async () => {
    const { plugin, requests } = destination({ flushIntervalMs: 100 });
    const local = vi.fn();
    configureLogline({ plugins: [plugin, { name: 'local', onLog: local }] });
    expect(LOG('small')).toBeUndefined();
    expect(local).toHaveBeenCalledTimes(1);
    await advance(99);
    expect(requests).toHaveLength(0);
    await advance(2);
    expect(requests[0].batch).toHaveLength(1);
    accept(requests[0]);
    emit(2);
    expect(requests).toHaveLength(1);
    await advance();
    expect(requests[1].batch).toHaveLength(2);
  });

  test('UTF-8 JSON byte limits trigger incremental delivery and bound retained in-flight bytes', async () => {
    const message = '🚀'.repeat(65);
    const probe = destination({ maxBatchEvents: 1 });
    const timeProvider = { now: () => ({ epochMs: 1700000000000, sequence: 0, stableTimeMs: 1700000000000 }) };
    configureLogline({ plugins: [probe.plugin], timeProvider });
    LOG(message);
    await advance();
    const bytes = new TextEncoder().encode(JSON.stringify(probe.requests[0].batch[0])).length;
    expect(probe.plugin.getMetrics().bytes).toBe(bytes);
    probe.plugin.dispose();
    const { plugin, requests } = destination({
      maxBatchEvents: 100,
      maxBatchBytes: 2 * bytes + 3,
      maxQueueBytes: 3 * bytes,
    });
    configureLogline({ plugins: [plugin] });
    LOG(message);
    await advance();
    expect(requests).toHaveLength(0);
    LOG(message);
    await advance();
    expect(requests.map((r) => new TextEncoder().encode(JSON.stringify(r.batch)).length)).toEqual([2 * bytes + 3]);
    LOG(message);
    LOG(message);
    expect(plugin.getMetrics()).toMatchObject({ queued: 1, inFlight: 2, bytes: 3 * bytes, overflow: 1 });
    accept(requests[0]);
    await advance(1001);
    expect(requests[1].batch).toHaveLength(1);
    accept(requests[1]);
    await advance();
    expect(plugin.getMetrics()).toMatchObject({ bytes: 0, accepted: 3 });
  });

  test('both due retries and fresh events advance while a single shared request slot is busy', async () => {
    const { plugin, requests } = destination();
    configureLogline({ plugins: [plugin] });
    emit(4);
    await advance();
    const failed = requests[0];
    failed.reject(new Error('transient'));
    await advance();
    const held = requests[1];
    emit(6, 'fresh');
    await advance(110);
    expect(requests).toHaveLength(2);
    accept(held);
    await advance();
    const mixed = requests[2];
    expect(ids(mixed.batch).filter((id) => ids(failed.batch).includes(id))).toHaveLength(1);
    expect(requests).toHaveLength(3);
    accept(mixed);
    await advance();
    const next = requests[3];
    expect(ids(next.batch).filter((id) => ids(failed.batch).includes(id))).toHaveLength(1);
    expect(new Set([...ids(mixed.batch), ...ids(next.batch)]).size).toBe(4);
  });

  test('pause, repeated installation, list replacement, reset and disposal have distinct effects', async () => {
    const { plugin, requests } = destination({ maxBatchEvents: 1 });
    const target = new EventTarget();
    const listeners = vi.spyOn(target, 'addEventListener');
    vi.stubGlobal('window', target);
    try {
      configureLogline({ plugins: [plugin] });
      configureLogline({ plugins: [plugin] });
      plugin.pause();
      LOG('retained');
      configureLogline({ plugins: [] });
      LOG('not retained');
      resetLoglineConfig();
      LOG('also not retained');
      await advance(2000);
      expect(requests).toHaveLength(0);
      expect(plugin.getMetrics().queued).toBe(1);
      plugin.resume();
      await advance();
      expect(requests).toHaveLength(1);
      accept(requests[0]);
      await advance();
      configureLogline({ plugins: [plugin] });
      LOG('in flight');
      LOG('waiting');
      await advance();
      const flush = plugin.flush({ timeout: 3000 });
      plugin.dispose();
      plugin.dispose();
      expect(requests[1].signal.aborted).toBe(true);
      await expect(flush).resolves.toMatchObject({ discarded: 2, remaining: 0 });
      accept(requests[1]); // An adapter that ignores abort must not resurrect discarded records.
      configureLogline({ plugins: [plugin] });
      LOG('after dispose');
      await advance(5000);
      expect(requests).toHaveLength(2);
      expect(plugin.getMetrics()).toMatchObject({ accepted: 1, discarded: 2, bytes: 0 });
      expect(listeners).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('timeouts abort, late acknowledgements are ignored, and malformed responses exhaust the attempt budget', async () => {
    const { plugin, requests } = destination({ requestTimeoutMs: 20, maxAttempts: 2, maxQueueEvents: 2 });
    configureLogline({ plugins: [plugin] });
    emit(2);
    await advance();
    emit(4, 'overflow');
    expect(plugin.getMetrics()).toMatchObject({ inFlight: 2, queued: 0, overflow: 4 });
    await advance(21);
    expect(requests[0].signal.aborted).toBe(true);
    accept(requests[0]);
    await advance(101);
    const retries = requests.slice(1).flatMap((r) => [...r.batch]);
    expect(ids(retries)).toEqual(expect.arrayContaining(ids(requests[0].batch)));
    for (const request of requests.slice(1)) {
      request.resolve({
        acceptedEventIds: [request.batch[0].id],
        retryableEventIds: [request.batch[0].id],
        rejectedEventIds: [],
      });
    }
    await advance();
    expect(plugin.getMetrics()).toMatchObject({ accepted: 0, rejected: 2 });
  });

  test('destination cooldown applies to fresh sends but expired records never retry', async () => {
    const { plugin, requests } = destination({ maxBatchEvents: 1, maxAgeMs: 150 });
    configureLogline({ plugins: [plugin] });
    LOG('retry');
    await advance();
    requests[0].resolve({
      acceptedEventIds: [],
      rejectedEventIds: [],
      retryableEventIds: ids(requests[0].batch),
      retryAfterMs: 300,
    });
    await advance(100);
    LOG('also expires');
    await advance(199);
    expect(requests).toHaveLength(1);
    LOG('fresh');
    await advance(5);
    expect(requests).toHaveLength(2);
    expect(requests[1].batch[0].id).not.toBe(requests[0].batch[0].id);
    accept(requests[1]);
    await advance();
    expect(plugin.getMetrics()).toMatchObject({ expired: 2, accepted: 1 });
  });

  test('destination sampling and failures are independent of console, upstream policy and other destinations', async () => {
    const filter = vi.fn(() => true);
    const slow = destination({ sampleRate: 0, levelSampleRates: { ERROR: 1 }, filter, maxBatchEvents: 1 });
    const fast = destination({ maxBatchEvents: 1, maxConcurrentBatches: 2 });
    configureLogline({
      plugins: [slow.plugin, fast.plugin],
      filter: (r) => r.messageText !== 'globally blocked',
      throttle: { ms: 1000 },
    });
    LOG('globally blocked');
    LOG({ key: 'same', message: 'kept locally' });
    LOG({ key: 'same', message: 'throttled' });
    ERROR('report this');
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
    await advance();
    expect(slow.requests).toHaveLength(1);
    expect(slow.requests[0].batch[0].level).toBe('ERROR');
    expect(fast.requests).toHaveLength(2);
    fast.requests.forEach(accept);
    const decisions = filter.mock.calls.length;
    slow.requests[0].reject(new Error('synthetic network outage'));
    await advance(101);
    expect(filter).toHaveBeenCalledTimes(decisions);
    expect(slow.requests[1].batch).toEqual(slow.requests[0].batch);
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(fast.plugin.getMetrics().accepted).toBe(2);
    expect(slow.plugin.getMetrics().sampledOut).toBe(1);
  });

  test('startup takeover, raw console and global errors remain local while a reporting request is stalled', async () => {
    vi.useRealTimers(); // fake-indexeddb delivers asynchronous IDB events on the native task queue.
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('IDBKeyRange', IDBKeyRange);
    vi.stubGlobal('__LOGLINE_GET_LOGS__', undefined);
    const { plugin, requests } = destination({ maxBatchEvents: 1, levelSampleRates: { ERROR: 0 } });
    configureLogline({ plugins: [plugin] });
    let storage: ReturnType<typeof createIndexedDBLoggingPlugin> | undefined;
    try {
      await import('../../html-interop');
      console.error('startup-only');
      storage = createIndexedDBLoggingPlugin({ databaseName: 'synthetic-reporting-coverage' });
      configureLogline({ plugins: [storage, plugin] });
      const error = new Event('error');
      Object.defineProperty(error, 'message', { value: 'global-only' });
      target.dispatchEvent(error);
      const rejection = new Event('unhandledrejection');
      Object.defineProperty(rejection, 'reason', { value: 'rejection-only' });
      target.dispatchEvent(rejection);
      console.log('raw console after takeover');
      LOG('ordinary dispatch');
      ERROR('sampled out here only');
      const readMessages = async () => (await storage?.getLogs(10))?.map((row) => row.message);
      await expect
        .poll(readMessages)
        .toEqual(
          expect.arrayContaining([
            '[html] startup-only',
            '[global error] global-only',
            '[global unhandledrejection] rejection-only',
            'ordinary dispatch',
            'sampled out here only',
          ]),
        );
      expect(requests).toHaveLength(1);
      expect(requests[0].batch.map((e) => e.message)).toEqual(['ordinary dispatch']);
      expect(plugin.getMetrics()).toMatchObject({ queued: 0, inFlight: 1, accepted: 0, sampledOut: 1 });
      const persisted = await readMessages();
      const flush = plugin.flush();
      accept(requests[0]);
      await expect(flush).resolves.toMatchObject({ accepted: 1 });
      expect(await readMessages()).toEqual(persisted); // Reporting acks cannot clear the diagnostic store.
    } finally {
      storage?.dispose();
      vi.unstubAllGlobals();
    }
  });

  test('one permanent rejection neither retries nor prevents another event from retrying', async () => {
    const { plugin, requests } = destination({ maxBatchEvents: 3 });
    configureLogline({ plugins: [plugin] });
    emit(3);
    const drain = plugin.flush();
    await advance();
    const [ok, bad, again] = requests[0].batch;
    requests[0].resolve({ acceptedEventIds: [ok.id], rejectedEventIds: [bad.id], retryableEventIds: [again.id] });
    await advance(101);
    expect(requests[1].batch).toEqual([again]);
    accept(requests[1]);
    await advance();
    await expect(drain).resolves.toMatchObject({ accepted: 2, rejected: 1, remaining: 0 });
  });

  test('excess flush waiters fail immediately without allocating timers or disturbing existing cutoffs', async () => {
    const { plugin } = destination({ maxFlushWaiters: 2 });
    configureLogline({ plugins: [plugin] });
    plugin.pause();
    emit(1);
    const first = plugin.flush({ timeout: 10 });
    emit(1);
    const second = plugin.flush();
    const timers = vi.getTimerCount();
    for (let i = 0; i < 25; i++) await expect(plugin.flush()).rejects.toThrow(RangeError);
    await expect(plugin.flush({ timeout: 0 })).resolves.toMatchObject({ remaining: 2, timedOut: true });
    expect(vi.getTimerCount()).toBe(timers);
    await advance(11);
    await expect(first).resolves.toMatchObject({ remaining: 1, timedOut: true });
    const replacement = plugin.flush();
    plugin.dispose();
    for (const waiter of [second, replacement])
      await expect(waiter).resolves.toMatchObject({ discarded: 2, remaining: 0, timedOut: false });
    await expect(plugin.flush()).resolves.toMatchObject({ remaining: 0, timedOut: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([301, Number.MAX_VALUE, Infinity, NaN])(
    'invalid cooldown %s does not delay fresh events or acknowledge a batch',
    async (retryAfterMs) => {
      const { plugin, requests } = destination({ maxBatchEvents: 1, maxRetryAfterMs: 300 });
      configureLogline({ plugins: [plugin] });
      LOG('original');
      await advance();
      LOG('fresh');
      requests[0].resolve({
        acceptedEventIds: ids(requests[0].batch),
        retryableEventIds: [],
        rejectedEventIds: [],
        retryAfterMs,
      });
      await advance();
      expect(requests[1].batch[0].message).toBe('fresh');
      expect(plugin.getMetrics()).toMatchObject({ accepted: 0, failed: 1 });
      accept(requests[1]);
      await advance(101);
      expect(requests[2].batch).toEqual(requests[0].batch);
      accept(requests[2]);
      await advance();
      expect(plugin.getMetrics()).toMatchObject({ accepted: 2, retried: 1 });
    },
  );

  test.each(['missing', 'duplicate', 'foreign', 'invalid delay'])(
    'an acknowledgement with %s data acknowledges nothing',
    async (kind) => {
      const { plugin, requests } = destination();
      configureLogline({ plugins: [plugin] });
      emit(2);
      await advance();
      const [a, b] = ids(requests[0].batch);
      requests[0].resolve({
        acceptedEventIds:
          kind === 'missing' ? [a] : [a, kind === 'duplicate' ? a : kind === 'foreign' ? 'unrelated' : b],
        retryableEventIds: [],
        rejectedEventIds: [],
        retryAfterMs: kind === 'invalid delay' ? -1 : undefined,
      });
      await advance(101);
      expect(requests[1].batch).toEqual(requests[0].batch);
      expect(plugin.getMetrics()).toMatchObject({ retried: 2, accepted: 0, rejected: 0 });
    },
  );

  test('throwing admission hooks discard only their own event; status reentry and failure never report themselves', async () => {
    const status = vi.fn(async () => {
      LOG('hook-local-only');
      throw new Error('synthetic status exception');
    });
    const { plugin, requests } = destination({
      filter: (r) => {
        if (r.messageText === 'filter fails') throw new Error('synthetic filter exception');
        return true;
      },
      transform: (event) => {
        if (event.message === 'transform fails') throw new Error('synthetic transform exception');
        return event;
      },
      onStatus: status,
      maxBatchEvents: 1,
    });
    configureLogline({ plugins: [plugin] });
    LOG('filter fails');
    LOG('transform fails');
    LOG('kept');
    expect(status).not.toHaveBeenCalled();
    await advance();
    expect(status).toHaveBeenCalled();
    expect(requests[0].batch.map((e) => e.message)).toEqual(['kept']);
    accept(requests[0]);
    await advance(1100);
    expect(requests).toHaveLength(1);
    expect(plugin.getMetrics()).toMatchObject({ discarded: 2, accepted: 1, inFlight: 0, queued: 0 });
    expect(plugin.getMetrics().failed).toBeGreaterThanOrEqual(2);
    expect(console.error).not.toHaveBeenCalled();
  });

  test.each([
    { sampleRate: NaN },
    { sampleRate: 1.1 },
    { levelSampleRates: { ERROR: -1 } },
    { maxConcurrentBatches: 0 },
    { maxBatchEvents: 1.5 },
  ])('rejects invalid options: %j', (options) => {
    expect(() => destination(options)).toThrow();
  });
});
