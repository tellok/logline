import { LOG_LEVEL_INDEX, LOG_LEVELS, type LogLevelName } from './constants';
import { isTestEnv } from './env';
import { maskString } from './masking';
import { getLoglineConfig } from './state';
import { type LoggerFunction, type LogInput, type LogMessage, type LogRecord, type LoglineConfig } from './types';
import { safeStringify } from './utils';

type ConsoleMethod = 'debug' | 'log' | 'warn' | 'error';

export { type LoggerFunction };

type ConsoleWriter = (message: string, ...args: readonly unknown[]) => void;

// Create a console writer that falls back to console.log if the requested method is absent.
/**
 * Create a console writer with a consistent signature and a console.log fallback.
 * @param method Requested console method name.
 */
const createConsoleWriter = (method: ConsoleMethod): ConsoleWriter => {
  return (message: string, ...args: readonly unknown[]) => {
    const target = console[method];

    const fallback = console.log;
    const callable = typeof target === 'function' ? target : fallback;
    callable(message, ...args);
  };
};

const writers: Record<LogLevelName, ConsoleWriter> = {
  TRACE: createConsoleWriter('debug'),
  DEBUG: createConsoleWriter('debug'),
  LOG: createConsoleWriter('log'),
  WARN: createConsoleWriter('warn'),
  ERROR: createConsoleWriter('error'),
};

const isTest = isTestEnv();

/**
 * Format console-style placeholders while retaining unused arguments for later output.
 * @param template Log format string.
 * @param values Arguments following the format string.
 */
const replacePlaceholders = (
  template: string,
  values: readonly unknown[],
): {
  formatted: string;
  remaining: unknown[];
} => {
  let valueIndex = 0;
  const formatted = template.replace(/%[%sdifoOj]/g, (token) => {
    if (token === '%%') return '%';
    if (valueIndex >= values.length) return token;
    const current = values[valueIndex++];

    switch (token) {
      case '%d':
      case '%i': {
        if (typeof current === 'bigint') return current.toString();
        const parsed = Number(current);
        return Number.isFinite(parsed) ? String(parsed) : safeStringify(current);
      }
      case '%f': {
        const numeric = Number(current);
        return Number.isFinite(numeric) ? String(numeric) : safeStringify(current);
      }
      case '%o':
      case '%O':
      case '%j': {
        return safeStringify(current);
      }
      default: {
        return safeStringify(current);
      }
    }
  });

  return {
    formatted,
    remaining: values.slice(valueIndex),
  };
};

const isTemplateStringsArray = (value: unknown): value is TemplateStringsArray => {
  return Array.isArray(value) && 'raw' in value;
};

interface NormalizedLogInput {
  readonly enable: boolean;
  readonly key?: string;
  readonly args: readonly unknown[];
  readonly messageText?: string;
  readonly messageArgs: readonly unknown[];
}

const normalizeMessage = (
  message: LogMessage,
  params: readonly unknown[],
): {
  readonly args: readonly unknown[];
  readonly messageText: string;
  readonly messageArgs: readonly unknown[];
} => {
  if (isTemplateStringsArray(message)) {
    const rendered = String.raw(message, ...params);
    return {
      args: [rendered],
      messageText: rendered,
      messageArgs: [],
    };
  }
  return {
    args: [message, ...params],
    messageText: message,
    messageArgs: params,
  };
};

const normalizeLogInput = (input: LogInput, rest: readonly unknown[]): NormalizedLogInput => {
  if (typeof input === 'string' || isTemplateStringsArray(input)) {
    const { args, messageArgs, messageText } = normalizeMessage(input, rest);
    return {
      enable: true,
      key: undefined,
      args,
      messageText,
      messageArgs,
    };
  }
  const params = input.params ?? rest;
  const { args, messageArgs, messageText } = normalizeMessage(input.message, params);
  return {
    enable: input.enable !== false,
    key: input.key,
    args,
    messageText,
    messageArgs,
  };
};

/**
 * Format log arguments with a level and optional scope.
 * @param level Log level.
 * @param args User-provided log arguments.
 */
const formatArgs = (args: readonly unknown[], scope?: string): unknown[] => {
  if (args.length === 0) return scope ? [maskString(scope)] : [];

  const prefixParts: unknown[] = [];
  if (scope) prefixParts.push(maskString(scope));

  const [first, ...rest] = args;
  if (typeof first === 'string') {
    const { formatted, remaining } = replacePlaceholders(first, rest);
    const maskedFormatted = maskString(formatted);
    const maskedRemaining = remaining.map((arg) => (typeof arg === 'string' ? maskString(arg) : arg));
    return [...prefixParts, maskedFormatted, ...maskedRemaining];
  }

  const maskedArgs = args.map((arg) => (typeof arg === 'string' ? maskString(arg) : arg));
  return [...prefixParts, ...maskedArgs];
};

const pluginErrorReporter = (pluginName: string, error: unknown): void => {
  const tag = `[logline:${pluginName}]`;

  console.error(tag, error);
};

const isThenable = (value: unknown): value is Promise<unknown> => {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as Promise<unknown>).then === 'function'
  );
};

const notifyPlugins = (record: LogRecord, config: LoglineConfig): void => {
  if (config.plugins.length === 0) return;
  config.plugins.forEach((plugin) => {
    if (!plugin.onLog) return;
    try {
      const maybePromise = plugin.onLog(record);
      if (isThenable(maybePromise)) {
        void maybePromise.catch((error) => pluginErrorReporter(plugin.name, error));
      }
    } catch (error) {
      pluginErrorReporter(plugin.name, error);
    }
  });
};

const shouldPassFilter = (record: LogRecord, config: LoglineConfig): boolean => {
  if (!config.filter) return true;
  try {
    return config.filter(record);
  } catch (error) {
    pluginErrorReporter('filter', error);
    return false;
  }
};

const throttleCache = new Map<string, number>();
let lastThrottleRevision = -1;

const resolveThrottleKey = (record: LogRecord, config: LoglineConfig): string | undefined => {
  if (!config.throttle) return undefined;
  if (record.key) return record.key;
  const keyOption = config.throttle.key;
  if (typeof keyOption === 'string') return keyOption;
  if (typeof keyOption === 'function') {
    try {
      return keyOption(record);
    } catch (error) {
      pluginErrorReporter('key', error);
      return undefined;
    }
  }
  return undefined;
};

const shouldSkipByThrottle = (record: LogRecord, config: LoglineConfig): boolean => {
  if (!config.throttle) return false;
  if (config.revision !== lastThrottleRevision) {
    throttleCache.clear();
    lastThrottleRevision = config.revision;
  }
  const key = resolveThrottleKey(record, config);
  if (!key) return false;
  const lastTime = throttleCache.get(key);
  const duration = config.throttle.ms;
  const currentTime = record.timestamp.stableTimeMs;
  if (lastTime !== undefined && currentTime - lastTime < duration) {
    return true;
  }
  throttleCache.set(key, currentTime);
  return false;
};

const buildRecord = (level: LogLevelName, input: NormalizedLogInput, config: LoglineConfig): LogRecord => {
  const scope: string | undefined = undefined;
  const formattedArgs = formatArgs(input.args, scope);
  return {
    level,
    key: input.key,
    args: input.args,
    formattedArgs,
    scope,
    messageText: input.messageText,
    messageArgs: input.messageArgs,
    timestamp: config.timeProvider.now(),
  };
};

let logDepth = 0;
const MAX_LOG_DEPTH = 3;

/**
 * Create a level-specific logger that stays silent in test environments.
 * @param level Log level.
 */
const createLogger = (level: LogLevelName): LoggerFunction => {
  if (isTest) {
    return () => undefined;
  }
  const writer = writers[level];
  return (input: LogInput, ...args: readonly unknown[]) => {
    if (logDepth >= MAX_LOG_DEPTH) {
      // Prevent recursion through console proxies or plugin callbacks.
      return;
    }

    logDepth++;
    try {
      const config = getLoglineConfig();
      const normalized = normalizeLogInput(input, args);
      if (!normalized.enable) return;
      const record = buildRecord(level, normalized, config);
      if (!shouldPassFilter(record, config)) return;
      if (shouldSkipByThrottle(record, config)) return;
      const consoleArgs: readonly unknown[] = [`[${record.level}]`, ...record.formattedArgs];
      const [formattedFirst, ...formattedRest] = consoleArgs;
      const first = typeof formattedFirst === 'string' ? formattedFirst : safeStringify(formattedFirst);
      writer(first, ...formattedRest);
      notifyPlugins(record, config);
    } catch (error) {
      console.error('[logline:logger]', error);
    } finally {
      logDepth--;
    }
  };
};

/**
 * Factory for creating a logger at a selected level.
 * @param level Log level.
 */
export const createLoggerByLevel = (level: LogLevelName): LoggerFunction => {
  return createLogger(level);
};

/** Lowest-level logger for fine-grained tracing. */
export const TRACE = createLogger('TRACE');
export const DEBUG = createLogger('DEBUG');
export const LOG = createLogger('LOG');
export const WARN = createLogger('WARN');
export const ERROR = createLogger('ERROR');

/**
 * List log functions eligible for pure-call removal below a threshold.
 * @param targetLevel Minimum retained level; lower-level functions are removable.
 */
export const resolvePureCalls = (targetLevel?: LogLevelName): LogLevelName[] => {
  if (!targetLevel) return [];
  const index = LOG_LEVEL_INDEX[targetLevel];
  if (index <= 0) return [];
  return LOG_LEVELS.filter((level) => LOG_LEVEL_INDEX[level] < index);
};

/**
 * Check whether a string is a supported level.
 * @param value String to validate.
 */
export const isLogLevelName = (value: string | undefined): value is LogLevelName => {
  if (!value) return false;
  return LOG_LEVELS.some((level) => level === value);
};
