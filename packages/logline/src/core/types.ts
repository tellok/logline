import { type LogLevelName } from './constants';

export type LogMessage = string | TemplateStringsArray;

/**
 * Flat string key/value pairs attached to a record, Sentry-style.
 * Keys must match /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/ so every stored tag stays queryable.
 */
export type LogTags = Readonly<Record<string, string>>;

export interface LogInputObject {
  /**
   * Key used for throttling and related processing.
   */
  readonly key?: string;
  /**
   * Whether the record is enabled; false skips it.
   */
  readonly enable?: boolean;
  /**
   * Message text or tagged template strings.
   */
  readonly message: LogMessage;
  /**
   * Arguments equivalent to subsequent parameters of a non-object call.
   */
  readonly params?: readonly unknown[];
  /**
   * Per-record tags merged over the configured global tags.
   */
  readonly tags?: LogTags;
}

export type LogInput = LogInputObject | LogMessage;

export type LoggerFunction = (input: LogInput, ...args: readonly unknown[]) => void;

export interface LogTimestamp {
  readonly epochMs: number;
  readonly sequence: number;
  readonly stableTimeMs: number;
}

export interface LogRecord {
  readonly level: LogLevelName;
  readonly args: readonly unknown[];
  readonly formattedArgs: readonly unknown[];
  readonly scope?: string;
  /**
   * Throttle key supplied by the log input.
   */
  readonly key?: string;
  /**
   * Original message text, present only when the first argument is a string.
   */
  readonly messageText?: string;
  /**
   * Arguments following a string message, or all original arguments otherwise.
   */
  readonly messageArgs: readonly unknown[];
  /**
   * Normalized global and per-record tags; absent when neither is set.
   */
  readonly tags?: LogTags;
  readonly timestamp: LogTimestamp;
}

export type LogFilter = (record: LogRecord) => boolean;

export type LogThrottleKeyResolver = (record: LogRecord) => string | undefined;
export type LogThrottleKey = string | LogThrottleKeyResolver;

export interface LogThrottleConfig {
  /**
   * Throttle interval in milliseconds.
   */
  readonly ms: number;
  /**
   * Fixed throttle key or a resolver deriving a key from each record.
   */
  readonly key?: LogThrottleKey;
}

export interface LogTimeProvider {
  readonly now: () => LogTimestamp;
}

export interface LoglinePluginContext {
  readonly log: LoggerFunction;
}

export interface LoglinePlugin {
  readonly name: string;
  readonly install?: (context: LoglinePluginContext) => void;
  readonly onLog?: (record: LogRecord) => void | Promise<void>;
}

export interface LoglineConfig {
  /**
   * Filter returning false to reject a record.
   * Rejected records do not reach the console or plugins.
   */
  readonly filter?: LogFilter;
  /**
   * Throttle configuration.
   */
  readonly throttle?: LogThrottleConfig;
  /**
   * Plugins extending processing with reporting, storage, or other behavior.
   */
  readonly plugins: readonly LoglinePlugin[];
  /**
   * Global tags merged into every record, below per-record tags.
   */
  readonly tags?: LogTags;
  /**
   * Provider for custom timestamp generation.
   */
  readonly timeProvider: LogTimeProvider;
  /**
   * Configuration revision invalidating internal caches.
   */
  readonly revision: number;
}

export interface LoglineConfigInput {
  /**
   * Filter returning false to reject a record.
   * Rejected records do not reach the console or plugins.
   */
  readonly filter?: LogFilter;
  /**
   * Throttle configuration as milliseconds or a complete options object.
   * False disables throttling.
   */
  readonly throttle?: LogThrottleConfig | number | false;
  /**
   * Plugins extending processing with reporting, storage, or other behavior.
   */
  readonly plugins?: readonly LoglinePlugin[];
  /**
   * Global tags merged into every record; pass an empty object to clear.
   */
  readonly tags?: LogTags;
  /**
   * Provider for custom timestamp generation.
   */
  readonly timeProvider?: LogTimeProvider;
}
