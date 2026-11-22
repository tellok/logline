import type { LogLevelName } from '../../core/constants';
import type { LogRecord, LoglinePlugin } from '../../core/types';
import type { ReportingEvent } from './snapshot';

export interface ReportingSendContext {
  /** Aborted on timeout, expiry or disposal. Adapters should cancel their request. */
  readonly signal: AbortSignal;
}

/** Partition every submitted ID exactly once; malformed results acknowledge nothing. */
export interface ReportingSendResult {
  readonly acceptedEventIds: readonly string[];
  readonly retryableEventIds: readonly string[];
  readonly rejectedEventIds: readonly string[];
  /** Minimum delay before the next request to this destination. */
  readonly retryAfterMs?: number;
}

export interface ReportingTransport {
  readonly name: string;
  /** Make a single delivery attempt. The reporting plugin owns retries. */
  send(batch: readonly ReportingEvent[], context: ReportingSendContext): Promise<ReportingSendResult>;
}

export interface ReportingOptions {
  readonly transport: ReportingTransport;
  readonly sampleRate?: number;
  readonly levelSampleRates?: Partial<Readonly<Record<LogLevelName, number>>>;
  /** Invoked once before sampling. Must be fast and synchronous. */
  readonly filter?: (record: LogRecord) => boolean;
  /** Copied and redacted with each admitted record. */
  readonly context?: Readonly<Record<string, unknown>>;
  /** Additional own data-property names to copy from objects during bounded snapshotting. */
  readonly snapshotKeys?: readonly string[];
  /** Synchronously redact a sanitized snapshot. Return undefined to discard it. */
  readonly transform?: (event: ReportingEvent) => ReportingEvent | undefined;
  readonly maxQueueEvents?: number;
  readonly maxQueueBytes?: number;
  readonly maxBatchEvents?: number;
  readonly maxBatchBytes?: number;
  readonly flushIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxConcurrentBatches?: number;
  /** Maximum pending flush promises. Additional waiting calls reject with RangeError. */
  readonly maxFlushWaiters?: number;
  /** Largest valid destination cooldown requested by the transport. */
  readonly maxRetryAfterMs?: number;
  readonly maxAttempts?: number;
  readonly maxAgeMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  /** Coalesced notification outside producer dispatch. Do not log from this hook. */
  readonly onStatus?: (metrics: ReportingMetrics) => void | Promise<void>;
}

export interface ReportingMetrics {
  readonly queued: number;
  readonly inFlight: number;
  /** Total JSON event bytes held, including retrying and in-flight events. */
  readonly bytes: number;
  readonly accepted: number;
  readonly retried: number;
  readonly rejected: number;
  readonly sampledOut: number;
  readonly overflow: number;
  readonly expired: number;
  readonly discarded: number;
  /** Number of errors, not affected event count. Never contains transport payloads. */
  readonly failed: number;
  readonly lastFailure?: string;
}

/** Counts refer only to events outstanding when this flush began. */
export interface ReportingFlushResult {
  readonly accepted: number;
  readonly rejected: number;
  readonly expired: number;
  readonly discarded: number;
  readonly remaining: number;
  readonly timedOut: boolean;
}

export interface ReportingLoggingPlugin extends LoglinePlugin {
  onLog(record: LogRecord): void;
  getMetrics(): ReportingMetrics;
  /** Request immediate bounded delivery; timing out does not cancel delivery. */
  flush(options?: { readonly timeout?: number }): Promise<ReportingFlushResult>;
  /** Suspend new requests; retain bounded intake and let current requests finish. */
  pause(): void;
  resume(): void;
  /** Permanently disable intake, discard buffered events and abort active requests. */
  dispose(): void;
}
