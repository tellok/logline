import { LOG_LEVELS } from '../../core/constants';
import type { ReportingOptions } from './types';

export const MAX_TIMER = 2_147_483_647;
const defaults = {
  maxQueueEvents: 1000,
  maxQueueBytes: 1024 * 1024,
  maxBatchEvents: 50,
  maxBatchBytes: 64 * 1024,
  flushIntervalMs: 1000,
  requestTimeoutMs: 10_000,
  maxConcurrentBatches: 1,
  maxFlushWaiters: 16,
  maxRetryAfterMs: 300_000,
  maxAttempts: 5,
  maxAgeMs: 300_000,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
};

function checkRate(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Sample rate must be between 0 and 1');
  return value;
}

/** Validate once and detach scheduling and sampling policy from caller-owned options. */
export function normalize(options: ReportingOptions) {
  if (!options?.transport?.name || typeof options.transport.send !== 'function')
    throw new TypeError('Invalid reporting transport');
  for (const key of ['filter', 'transform', 'onStatus'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'function') throw new TypeError(`Invalid ${key}`);
  }
  const limits = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const value = options[key] === undefined ? defaults[key] : options[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER) throw new RangeError(`Invalid ${key}`);
    limits[key] = value;
  }
  const rates = { ...options.levelSampleRates };
  for (const [level, rate] of Object.entries(rates)) {
    if (!LOG_LEVELS.some((name) => name === level) || typeof rate !== 'number')
      throw new TypeError('Invalid level sample rate');
    checkRate(rate);
  }
  return {
    ...options,
    ...limits,
    levelSampleRates: rates,
    sampleRate: checkRate(options.sampleRate === undefined ? 1 : options.sampleRate),
  };
}

type Decision = 'accepted' | 'rejected' | 'retry';

/** Adapters may be untyped; never release an event based on an ambiguous acknowledgement. */
export function validateResult(result: unknown, ids: readonly string[], maxRetryAfterMs: number) {
  if (typeof result !== 'object' || result === null) throw new TypeError();
  const expected = new Set(ids);
  const decisions = new Map<string, Decision>();
  for (const [key, decision] of [
    ['acceptedEventIds', 'accepted'],
    ['rejectedEventIds', 'rejected'],
    ['retryableEventIds', 'retry'],
  ] as const) {
    const group: unknown = Reflect.get(result, key);
    if (!Array.isArray(group)) throw new TypeError();
    const length = group.length;
    if (length > ids.length) throw new TypeError();
    for (let i = 0; i < length; i++) {
      const id: unknown = group[i];
      if (typeof id !== 'string' || !expected.delete(id)) throw new TypeError();
      decisions.set(id, decision);
    }
  }
  if (expected.size) throw new TypeError();
  const retryAfterMs: unknown = Reflect.get(result, 'retryAfterMs');
  if (
    retryAfterMs !== undefined &&
    (typeof retryAfterMs !== 'number' ||
      !Number.isFinite(retryAfterMs) ||
      retryAfterMs < 0 ||
      retryAfterMs > maxRetryAfterMs)
  )
    throw new TypeError();
  return { decisions, retryAfterMs: retryAfterMs ?? 0 };
}
