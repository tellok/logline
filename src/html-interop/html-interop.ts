import { type LogTimestamp } from '../core/config';
import { type LogLevelName } from '../core/constants';
import {
  HTML_INTEROP_DETACH_KEY,
  HTML_INTEROP_FLUSH_KEY,
  HTML_INTEROP_GLOBAL_KEY,
  HTML_INTEROP_PEEK_KEY,
  HTML_INTEROP_RESTORE_CONSOLE_KEY,
  type HtmlInteropDetach,
  type HtmlInteropFlush,
  type HtmlInteropPeek,
  type HtmlInteropRecord,
  type HtmlInteropState,
} from './html-interop-shared';

type ConsoleMethod = 'debug' | 'log' | 'warn' | 'error';

// Limit the startup buffer to 1000 records to handle failure bursts without unbounded memory growth.
const MAX_BUFFER_RECORDS = 1000;
const DEFAULT_SCOPE = '[html]';
const GLOBAL_ERROR_SCOPE = '[global error]';
const GLOBAL_UNHANDLED_REJECTION_SCOPE = '[global unhandledrejection]';

let lastEpochMs = 0;
let epochSequence = 0;

const buildTimestamp = (): LogTimestamp => {
  const epochMs = Date.now();
  if (epochMs !== lastEpochMs) {
    lastEpochMs = epochMs;
    epochSequence = 0;
  } else {
    epochSequence += 1;
  }

  const stableTimeMs = epochMs + epochSequence * 0.000001;

  return {
    epochMs,
    sequence: epochSequence,
    stableTimeMs,
  };
};

const mapConsoleToLevel: Record<ConsoleMethod, LogLevelName> = {
  debug: 'DEBUG',
  log: 'LOG',
  warn: 'WARN',
  error: 'ERROR',
};

const buildRecord = (level: LogLevelName, args: readonly unknown[], scope = DEFAULT_SCOPE): HtmlInteropRecord => {
  const timestamp = buildTimestamp();
  const messageText = typeof args[0] === 'string' ? args[0] : undefined;
  const messageArgs = messageText ? args.slice(1) : args;
  const formattedArgs = [scope, ...args];
  return {
    id: `${timestamp.epochMs}-${timestamp.sequence}`,
    level,
    args,
    formattedArgs,
    scope,
    messageText,
    messageArgs,
    timestamp,
  };
};

/**
 * Serialize error arguments solely for buffer deduplication.
 * @param value Error log argument.
 * @returns Comparable text.
 */
const serializeErrorArgument = (value: unknown): string => {
  if (value instanceof Error) {
    return `${value.name}:${value.message}\n${value.stack ?? ''}`;
  }
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return String(value);

  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, current: unknown) => {
      if (current instanceof Error) {
        return {
          message: current.message,
          name: current.name,
          stack: current.stack,
        };
      }
      if (typeof current === 'object' && current) {
        if (seen.has(current)) return '[Circular]';
        seen.add(current);
      }
      return current;
    });
    return serialized ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '[Unserializable]';
    }
  }
};

/**
 * Build an error fingerprint containing all original argument information.
 * @param record Buffered ERROR record.
 * @returns Fingerprint used to detect duplicate errors.
 */
const buildErrorFingerprint = (record: HtmlInteropRecord): string => {
  // Use a printable unit-separator symbol instead of raw U+001F to keep inline HTML safe.
  return record.args.map((argument) => serializeErrorArgument(argument)).join('\u241f');
};

/**
 * Deduplicate errors only at buffer capacity, keeping the latest matching record.
 * @param records Current buffer.
 */
const deduplicateErrors = (records: HtmlInteropRecord[]): void => {
  const seenFingerprints = new Set<string>();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || record.level !== 'ERROR') continue;
    const fingerprint = buildErrorFingerprint(record);
    if (seenFingerprints.has(fingerprint)) {
      records.splice(index, 1);
      continue;
    }
    seenFingerprints.add(fingerprint);
  }
};

/**
 * Evict the oldest non-error first; evict the oldest error only if all records are errors.
 * @param records Current buffer.
 */
const trimOverflowRecords = (records: HtmlInteropRecord[]): void => {
  while (records.length > MAX_BUFFER_RECORDS) {
    const oldestNonErrorIndex = records.findIndex((record) => record.level !== 'ERROR');
    records.splice(oldestNonErrorIndex >= 0 ? oldestNonErrorIndex : 0, 1);
  }
};

const handleLog = (
  state: HtmlInteropState,
  level: LogLevelName,
  args: readonly unknown[],
  scope = DEFAULT_SCOPE,
): void => {
  if (state.detached) return;
  try {
    const record = buildRecord(level, args, scope);
    state.records.push(record);
    if (state.records.length >= MAX_BUFFER_RECORDS) {
      deduplicateErrors(state.records);
      trimOverflowRecords(state.records);
    }
  } catch (error) {
    const logError = state.consoleBackup?.error ?? console.error;
    logError('[logline:html-interop]', error);
  }
};

const installConsoleHooks = (state: HtmlInteropState): void => {
  if (typeof console === 'undefined') return;
  const backup: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};
  (Object.keys(mapConsoleToLevel) as ConsoleMethod[]).forEach((method) => {
    const original = console[method];
    backup[method] = typeof original === 'function' ? original.bind(console) : undefined;

    console[method] = (...args: unknown[]) => {
      const level = mapConsoleToLevel[method];
      backup[method]?.(`[${level}]`, DEFAULT_SCOPE, ...args);
      handleLog(state, level, args);
    };
  });
  state.consoleBackup = backup;
};

const installErrorHooks = (state: HtmlInteropState): void => {
  if (typeof window === 'undefined') return;
  const errorHandler = (event: ErrorEvent): void => {
    const message = event.message || (event.error instanceof Error ? event.error.message : 'Unknown error');
    const args = event.error === undefined || event.error === message ? [message] : [message, event.error];
    handleLog(state, 'ERROR', args, GLOBAL_ERROR_SCOPE);
  };
  const rejectionHandler = (event: PromiseRejectionEvent): void => {
    const message =
      event.reason instanceof Error
        ? event.reason.message
        : typeof event.reason === 'string'
          ? event.reason
          : 'Unhandled rejection';
    const args = event.reason === undefined || event.reason === message ? [message] : [message, event.reason];
    handleLog(state, 'ERROR', args, GLOBAL_UNHANDLED_REJECTION_SCOPE);
  };
  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', rejectionHandler);
  state.errorHandler = errorHandler;
  state.rejectionHandler = rejectionHandler;
};

const createState = (): HtmlInteropState => {
  return {
    records: [],
    detached: false,
  };
};

const attachFlush = (state: HtmlInteropState): void => {
  const flush = async (): Promise<readonly HtmlInteropRecord[]> => {
    const merged = [...state.records];
    state.records.splice(0, state.records.length);
    return merged;
  };

  (globalThis as { [HTML_INTEROP_FLUSH_KEY]?: HtmlInteropFlush })[HTML_INTEROP_FLUSH_KEY] = flush;
};

const attachPeek = (state: HtmlInteropState): void => {
  const peek: HtmlInteropPeek = async () => {
    return [...state.records];
  };
  (globalThis as { [HTML_INTEROP_PEEK_KEY]?: HtmlInteropPeek })[HTML_INTEROP_PEEK_KEY] = peek;
};

const restoreConsole = (state: HtmlInteropState): void => {
  if (!state.consoleBackup) return;
  (Object.keys(state.consoleBackup) as (keyof typeof state.consoleBackup)[]).forEach((method) => {
    const original = state.consoleBackup?.[method];
    if (original) {
      console[method as ConsoleMethod] = original;
    }
  });
  state.consoleBackup = undefined;
};

const removeErrorHooks = (state: HtmlInteropState): void => {
  if (typeof window === 'undefined') return;
  if (state.errorHandler) {
    window.removeEventListener('error', state.errorHandler);
    state.errorHandler = undefined;
  }
  if (state.rejectionHandler) {
    window.removeEventListener('unhandledrejection', state.rejectionHandler);
    state.rejectionHandler = undefined;
  }
};

/**
 * Stop console and global error capture while preserving records and transfer entries.
 * @param state Current HTML Interop state.
 */
const detachCapture = (state: HtmlInteropState): void => {
  if (state.detached) return;
  state.detached = true;
  restoreConsole(state);
  removeErrorHooks(state);
};

const attachDetach = (state: HtmlInteropState): void => {
  const detach: HtmlInteropDetach = () => {
    detachCapture(state);
  };
  (globalThis as { [HTML_INTEROP_DETACH_KEY]?: HtmlInteropDetach })[HTML_INTEROP_DETACH_KEY] = detach;
  // Keep the legacy entry while stopping both console and global error capture.
  (globalThis as { [HTML_INTEROP_RESTORE_CONSOLE_KEY]?: HtmlInteropDetach })[HTML_INTEROP_RESTORE_CONSOLE_KEY] = detach;
};

const installHtmlInterop = (): void => {
  if (typeof globalThis === 'undefined') return;
  const existing = (globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState })[HTML_INTEROP_GLOBAL_KEY];
  // Detached state still holds pending records; prevent reinstallation from replacing the buffer.
  if (existing) return;
  const state = createState();
  (globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState })[HTML_INTEROP_GLOBAL_KEY] = state;
  installConsoleHooks(state);
  installErrorHooks(state);
  attachFlush(state);
  attachPeek(state);
  attachDetach(state);
};

installHtmlInterop();

export const __LOGLINE_HTML_INTEROP_INSTALLED__ = true;
