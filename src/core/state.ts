import {
  type LogThrottleConfig,
  type LogThrottleKeyResolver,
  type LogTimeProvider,
  type LogTimestamp,
  type LoglineConfig,
  type LoglineConfigInput,
  type LoglinePlugin,
} from './types';

/**
 * Resolve the default throttle key; records without a key are not throttled.
 */
export const defaultThrottleKeyResolver: LogThrottleKeyResolver = () => undefined;

let lastEpochMs = 0;
let epochSequence = 0;

/**
 * Create a timestamp with stable high-resolution ordering.
 */
const buildTimestamp = (): LogTimestamp => {
  const epochMs = Date.now();
  if (epochMs !== lastEpochMs) {
    lastEpochMs = epochMs;
    epochSequence = 0;
  } else {
    epochSequence += 1;
  }

  // Combine epochMs and sequence for unique, monotonically increasing timestamps.
  // Example format:1733215678901.000001, 1733215678901.000002
  const stableTimeMs = epochMs + epochSequence * 0.000001;

  return {
    epochMs,
    sequence: epochSequence,
    stableTimeMs,
  };
};

const defaultTimeProvider: LogTimeProvider = {
  now: buildTimestamp,
};

let configState: LoglineConfig = {
  filter: undefined,
  throttle: undefined,
  plugins: [],
  timeProvider: defaultTimeProvider,
  revision: 0,
};

let automaticPlugins: readonly LoglinePlugin[] = [];

/**
 * Merge automatic and application plugins, deduplicating by object identity.
 * @param plugins Explicit application plugins.
 * @returns Plugins participating in log dispatch.
 */
const mergePlugins = (plugins: readonly LoglinePlugin[]): readonly LoglinePlugin[] => {
  const merged = [...automaticPlugins];
  for (const plugin of plugins) {
    if (!merged.includes(plugin)) merged.push(plugin);
  }
  return merged;
};

/**
 * Normalize throttle options; numbers are milliseconds, while false/nonpositive values disable it.
 * @param config User-provided throttle configuration.
 */
const normalizeThrottle = (config: LogThrottleConfig | number | false | undefined): LogThrottleConfig | undefined => {
  if (config === false || config === undefined) return undefined;
  if (typeof config === 'number') {
    if (config <= 0) return undefined;
    return {
      ms: config,
    };
  }
  const ms = config.ms;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return {
    ms,
    key: config.key,
  };
};

/**
 * Read the current global configuration.
 */
export const getLoglineConfig = (): LoglineConfig => ({
  ...configState,
  throttle: configState.throttle ? { ...configState.throttle } : undefined,
  plugins: mergePlugins(configState.plugins),
});

/**
 * Register a runtime plugin installed by the build integration.
 * Store automatic plugins separately so configureLogline cannot replace them.
 * @param plugin Automatic plugin participating in ongoing dispatch.
 * @returns Whether the plugin was newly registered.
 */
export const addAutomaticLoglinePlugin = (plugin: LoglinePlugin): boolean => {
  if (automaticPlugins.includes(plugin)) return false;
  automaticPlugins = [...automaticPlugins, plugin];
  configState = {
    ...configState,
    revision: configState.revision + 1,
  };
  return true;
};

/**
 * Remove an automatic plugin that is no longer active.
 * @param plugin Automatic plugin to remove.
 */
export const removeAutomaticLoglinePlugin = (plugin: LoglinePlugin): void => {
  if (!automaticPlugins.includes(plugin)) return;
  automaticPlugins = automaticPlugins.filter((candidate) => candidate !== plugin);
  configState = {
    ...configState,
    revision: configState.revision + 1,
  };
};

/**
 * Merge configuration updates while retaining unspecified fields.
 * @param input Partial configuration to merge.
 */
export const updateLoglineConfig = (input: LoglineConfigInput): LoglineConfig => {
  const nextThrottle = input.throttle === undefined ? configState.throttle : normalizeThrottle(input.throttle);
  const nextPlugins =
    input.plugins === undefined
      ? configState.plugins
      : input.plugins.filter((plugin) => !automaticPlugins.includes(plugin));
  configState = {
    filter: input.filter === undefined ? configState.filter : input.filter,
    throttle: nextThrottle,
    plugins: nextPlugins,
    timeProvider: input.timeProvider ?? configState.timeProvider,
    revision: configState.revision + 1,
  };
  return getLoglineConfig();
};

/**
 * Restore defaults for tests or state cleanup.
 */
export const resetLoglineConfig = (): LoglineConfig => {
  configState = {
    filter: undefined,
    throttle: undefined,
    plugins: [],
    timeProvider: defaultTimeProvider,
    revision: configState.revision + 1,
  };
  lastEpochMs = 0;
  epochSequence = 0;
  return getLoglineConfig();
};
