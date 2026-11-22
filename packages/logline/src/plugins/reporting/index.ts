import { MAX_TIMER, normalize, validateResult } from './policy';
import { createSnapshot, type ReportingEvent } from './snapshot';
import type { ReportingFlushResult, ReportingLoggingPlugin, ReportingMetrics, ReportingOptions } from './types';

export type { ReportingEvent, ReportingJsonValue } from './snapshot';
export type {
  ReportingFlushResult,
  ReportingLoggingPlugin,
  ReportingMetrics,
  ReportingOptions,
  ReportingSendContext,
  ReportingSendResult,
  ReportingTransport,
} from './types';

type Timer = ReturnType<typeof setTimeout>;
type Outcome = 'accepted' | 'rejected' | 'expired' | 'discarded';
interface Entry {
  readonly seq: number;
  readonly event: ReportingEvent;
  readonly bytes: number;
  readonly created: number;
  ready: number;
  attempts: number;
  sending: boolean;
}
interface Flush {
  readonly cutoff: number;
  readonly counts: Record<Outcome | 'remaining', number>;
  finish(timedOut: boolean): void;
}

/** Create an isolated, in-memory reporting destination. Construction and installation do not start timers or listeners. */
export function createReportingLoggingPlugin(options: ReportingOptions): ReportingLoggingPlugin {
  const config = normalize(options);
  const prefix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const entries = new Map<number, Entry>();
  const flushes = new Set<Flush>();
  const requests = new Map<AbortController, { timer: Timer; complete(result: unknown, failure?: string): void }>();
  const totals = {
    accepted: 0,
    retried: 0,
    rejected: 0,
    sampledOut: 0,
    overflow: 0,
    expired: 0,
    discarded: 0,
    failed: 0,
  };
  let seq = 0,
    bytes = 0,
    inFlight = 0,
    freshCount = 0,
    freshBytes = 0;
  let timer: Timer | undefined,
    scheduled = Infinity,
    cooldown = 0;
  let paused = false,
    disposed = false,
    preferRetry = false,
    inCallback = false,
    statusPending = false;
  let lastFailure: string | undefined;
  const getMetrics = (): ReportingMetrics => ({
    ...totals,
    queued: entries.size - inFlight,
    inFlight,
    bytes,
    lastFailure,
  });
  const fail = (reason: string) => {
    totals.failed++;
    lastFailure = reason;
  };
  // No internal console diagnostics: even asynchronous failures cannot feed a console proxy.
  function notify() {
    if (!config.onStatus || statusPending || disposed) return;
    statusPending = true;
    queueMicrotask(() => {
      if (disposed) return;
      inCallback = true;
      try {
        void Promise.resolve(config.onStatus?.(getMetrics()))
          .catch(() => fail('Status callback failed'))
          .finally(() => {
            statusPending = false;
          });
      } catch {
        statusPending = false;
        fail('Status callback failed');
      } finally {
        inCallback = false;
      }
    });
  }
  function wake(at: number) {
    if (disposed || at >= scheduled) return;
    clearTimeout(timer);
    scheduled = at;
    timer = setTimeout(
      () => {
        timer = undefined;
        scheduled = Infinity;
        pump();
      },
      Math.min(MAX_TIMER, Math.max(0, at - Date.now())),
    );
  }
  function settle(entry: Entry, outcome: Outcome) {
    entries.delete(entry.seq);
    bytes -= entry.bytes;
    if (entry.sending) inFlight--;
    if (!entry.attempts) {
      freshCount--;
      freshBytes -= entry.bytes;
    }
    totals[outcome]++;
    for (const flush of flushes) {
      if (entry.seq > flush.cutoff) continue;
      flush.counts[outcome]++;
      if (--flush.counts.remaining === 0) flush.finish(false);
    }
  }
  function retry(entry: Entry, now: number) {
    if (now >= entry.created + config.maxAgeMs) return settle(entry, 'expired');
    if (entry.attempts >= config.maxAttempts) return settle(entry, 'rejected');
    const cap = Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** Math.min(52, entry.attempts - 1));
    entry.ready = now + Math.ceil(cap * (0.5 + 0.5 * Math.random()));
    entry.sending = false;
    inFlight--;
  }
  // A non-cooperative adapter may retain its promise after abort. The listener holds
  // only a request key, never the timed-out batch or its completion closure.
  function watch(promise: Promise<unknown>, controller: AbortController) {
    void promise.then(
      (result) => requests.get(controller)?.complete(result),
      () => requests.get(controller)?.complete(undefined, 'Transport failed'),
    );
  }
  function send(batch: Entry[]) {
    const controller = new AbortController();
    const now = Date.now();
    let deadline = now + config.requestTimeoutMs;
    for (const entry of batch) {
      deadline = Math.min(deadline, entry.created + config.maxAgeMs);
      if (entry.attempts++) totals.retried++;
      else {
        freshCount--;
        freshBytes -= entry.bytes;
      }
      entry.sending = true;
      inFlight++;
    }
    function complete(result: unknown, failure?: string) {
      // Aborted/late completions must never acknowledge a later attempt.
      const request = requests.get(controller);
      if (!request) return;
      clearTimeout(request.timer);
      requests.delete(controller);
      const time = Date.now();
      if (time >= deadline) failure = 'Request timed out';
      let ack: ReturnType<typeof validateResult> | undefined;
      if (!failure) {
        try {
          ack = validateResult(
            result,
            batch.map((e) => e.event.id),
            config.maxRetryAfterMs,
          );
        } catch {
          failure = 'Malformed acknowledgement';
        }
      }
      if (disposed) return;
      if (failure) fail(failure);
      if (ack) cooldown = Math.max(cooldown, time + ack.retryAfterMs);
      for (const entry of batch) {
        const decision = ack?.decisions.get(entry.event.id);
        if (decision === 'accepted' || decision === 'rejected') settle(entry, decision);
        else retry(entry, time);
      }
      notify();
      wake(time);
    }
    requests.set(controller, {
      complete,
      timer: setTimeout(
        () => {
          complete(undefined, 'Request timed out');
          controller.abort();
        },
        Math.max(0, deadline - now),
      ),
    });
    try {
      inCallback = true;
      watch(
        Promise.resolve(config.transport.send(Object.freeze(batch.map((e) => e.event)), { signal: controller.signal })),
        controller,
      );
    } catch {
      complete(undefined, 'Transport failed');
    } finally {
      inCallback = false;
    }
  }
  // One bounded inventory scan per scheduler tick. Fresh records are FIFO; due retries
  // are FIFO by admission and alternate with fresh records when both lanes have work.
  function pump() {
    const now = Date.now();
    let next = Infinity,
      pendingBytes = 0,
      flushCutoff = 0;
    for (const flush of flushes) flushCutoff = Math.max(flushCutoff, flush.cutoff);
    const fresh: Entry[] = [],
      retries: Entry[] = [];
    for (const entry of entries.values()) {
      if (entry.sending) continue;
      const expiry = entry.created + config.maxAgeMs;
      if (expiry <= now) {
        settle(entry, 'expired');
        continue;
      }
      next = Math.min(next, expiry);
      if (paused || requests.size >= config.maxConcurrentBatches) continue;
      const ready = Math.max(cooldown, entry.ready);
      if (ready > now) {
        next = Math.min(next, ready);
        continue;
      }
      (entry.attempts ? retries : fresh).push(entry);
      pendingBytes += entry.bytes;
    }
    let i = 0,
      j = 0,
      launches = 0;
    while (
      !disposed &&
      !paused &&
      requests.size < config.maxConcurrentBatches &&
      launches < config.maxConcurrentBatches &&
      (i < fresh.length || j < retries.length)
    ) {
      const count = fresh.length - i + retries.length - j;
      const first = fresh[i];
      if (
        first &&
        j === retries.length &&
        first.seq > flushCutoff &&
        count < config.maxBatchEvents &&
        pendingBytes + count + 1 < config.maxBatchBytes &&
        now < first.created + config.flushIntervalMs
      ) {
        next = Math.min(next, first.created + config.flushIntervalMs);
        break;
      }
      const batch: Entry[] = [];
      let size = 2; // Brackets and commas count toward the UTF-8 JSON array byte limit.
      while (batch.length < config.maxBatchEvents && (i < fresh.length || j < retries.length)) {
        const takeRetry = j < retries.length && (i === fresh.length || preferRetry);
        const entry = takeRetry ? retries[j] : fresh[i];
        const additional = entry.bytes + (batch.length ? 1 : 0);
        if (size + additional > config.maxBatchBytes) break;
        if (takeRetry) j++;
        else i++;
        preferRetry = !takeRetry;
        size += additional;
        pendingBytes -= entry.bytes;
        batch.push(entry);
      }
      launches++;
      send(batch);
    }
    if (entries.size) wake(next);
    notify();
  }
  return {
    name: `reporting:${config.transport.name}`,
    getMetrics,
    onLog(record) {
      if (disposed || inCallback) return;
      inCallback = true;
      try {
        const rate = config.levelSampleRates[record.level] ?? config.sampleRate;
        if ((config.filter && !config.filter(record)) || rate === 0 || (rate < 1 && Math.random() >= rate)) {
          totals.sampledOut++;
          return;
        }
        if (entries.size >= config.maxQueueEvents || bytes >= config.maxQueueBytes) {
          totals.overflow++;
          return;
        }
        const id = seq + 1;
        const snapshot = createSnapshot(
          record,
          `${prefix}-${id.toString(36)}`,
          config.context,
          config.transform,
          config.snapshotKeys,
        );
        if (disposed) return;
        if (!snapshot) {
          totals.discarded++;
          return;
        }
        if (snapshot.bytes + 2 > config.maxBatchBytes || snapshot.bytes + bytes > config.maxQueueBytes) {
          totals.overflow++;
          return;
        }
        const now = Date.now();
        seq = id;
        entries.set(id, { ...snapshot, seq: id, created: now, ready: now, attempts: 0, sending: false });
        freshCount++;
        freshBytes += snapshot.bytes;
        bytes += snapshot.bytes;
        const wait =
          freshCount >= config.maxBatchEvents || freshBytes + freshCount + 1 >= config.maxBatchBytes
            ? 0
            : config.flushIntervalMs;
        wake(
          now +
            (paused || requests.size >= config.maxConcurrentBatches
              ? config.maxAgeMs
              : Math.min(wait, config.maxAgeMs)),
        );
      } catch {
        totals.discarded++;
        fail('Intake callback or snapshot failed');
      } finally {
        inCallback = false;
        notify();
      }
    },
    flush({ timeout = 30_000 } = {}) {
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAX_TIMER)
        throw new RangeError('Invalid flush timeout');
      if (timeout && entries.size && flushes.size >= config.maxFlushWaiters)
        return Promise.reject(new RangeError('Reporting flush waiter limit reached'));
      return new Promise<ReportingFlushResult>((resolve) => {
        const counts = { accepted: 0, rejected: 0, expired: 0, discarded: 0, remaining: entries.size };
        if (!entries.size || !timeout) return resolve({ ...counts, timedOut: entries.size > 0 });
        const flush: Flush = {
          cutoff: seq,
          counts,
          finish(timedOut) {
            clearTimeout(timeoutTimer);
            flushes.delete(flush);
            resolve({ ...counts, timedOut });
          },
        };
        flushes.add(flush);
        const timeoutTimer = setTimeout(() => flush.finish(true), timeout);
        wake(Date.now());
      });
    },
    pause() {
      paused = true;
    },
    resume() {
      if (paused && !disposed) {
        paused = false;
        if (entries.size) wake(Date.now());
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      for (const [controller, request] of requests) {
        clearTimeout(request.timer);
        controller.abort();
      }
      requests.clear();
      for (const entry of entries.values()) settle(entry, 'discarded');
    },
  };
}
