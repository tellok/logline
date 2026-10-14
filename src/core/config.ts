import { LOG } from './logger';
import { addAutomaticLoglinePlugin, removeAutomaticLoglinePlugin, updateLoglineConfig } from './state';
import { type LoglineConfig, type LoglineConfigInput, type LoglinePlugin } from './types';

export { defaultThrottleKeyResolver, getLoglineConfig, resetLoglineConfig } from './state';
export {
  type LogFilter,
  type LogRecord,
  type LogThrottleConfig,
  type LogThrottleKey,
  type LogThrottleKeyResolver,
  type LogTimeProvider,
  type LogTimestamp,
  type LoglineConfig,
  type LoglineConfigInput,
  type LoglinePlugin,
} from './types';

/**
 * Merge configuration updates while retaining unspecified fields.
 * @param input Partial configuration to merge.
 */
export const configureLogline = (input: LoglineConfigInput): LoglineConfig => {
  const config = updateLoglineConfig(input);

  if (input.plugins) {
    input.plugins.forEach((plugin) => {
      if (plugin.install) {
        plugin.install({
          log: LOG,
        });
      }
    });
  }

  return config;
};

/**
 * Register an automatic plugin independently of application-configured plugins.
 * Internal entry used only by Logline runtime integration.
 * @param plugin Automatically installed plugin instance.
 * @returns Cleanup function unregistering the automatic plugin.
 */
export const registerAutomaticLoglinePlugin = (plugin: LoglinePlugin): (() => void) => {
  const registered = addAutomaticLoglinePlugin(plugin);
  if (registered) {
    plugin.install?.({
      log: LOG,
    });
  }
  return () => removeAutomaticLoglinePlugin(plugin);
};
