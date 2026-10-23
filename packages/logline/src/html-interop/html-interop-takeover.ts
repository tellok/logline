import { type LogRecord, type LoglinePlugin } from '../core/config';
import {
  HTML_INTEROP_DETACH_KEY,
  HTML_INTEROP_FLUSH_KEY,
  HTML_INTEROP_GLOBAL_KEY,
  HTML_INTEROP_PEEK_KEY,
  HTML_INTEROP_RESTORE_CONSOLE_KEY,
  detachHtmlInteropCapture,
  type HtmlInteropRecord,
  type HtmlInteropState,
} from './html-interop-shared';

interface TakeOverResult {
  readonly taken: boolean;
  readonly flushedCount: number;
}

const pluginErrorReporter = (pluginName: string, error: unknown): void => {
  console.error(`[logline:${pluginName}]`, error);
};

const toLogRecord = (record: HtmlInteropRecord): LogRecord => {
  return {
    level: record.level,
    args: record.args,
    formattedArgs: record.formattedArgs,
    scope: record.scope,
    messageText: record.messageText,
    messageArgs: record.messageArgs,
    timestamp: record.timestamp,
  };
};

const notifyPlugins = async (records: readonly LogRecord[], plugins: readonly LoglinePlugin[]): Promise<void> => {
  if (plugins.length === 0) return;
  await Promise.all(
    records.map(async (record) => {
      await Promise.all(
        plugins.map(async (plugin) => {
          if (!plugin.onLog) return;
          try {
            await plugin.onLog(record);
          } catch (error) {
            pluginErrorReporter(plugin.name, error);
          }
        }),
      );
    }),
  );
};

const mergeRecords = async (): Promise<LogRecord[]> => {
  const flush = (globalThis as { [HTML_INTEROP_FLUSH_KEY]?: () => Promise<readonly HtmlInteropRecord[]> })[
    HTML_INTEROP_FLUSH_KEY
  ];
  if (!flush) return [];
  const records = await flush();
  return records.map(toLogRecord);
};

/**
 * Clear records and global entries to release references retained during startup capture.
 * @param state State whose records have been transferred.
 */
const destroyHtmlInteropCache = (state: HtmlInteropState): void => {
  state.records.splice(0, state.records.length);
  Reflect.deleteProperty(globalThis, HTML_INTEROP_GLOBAL_KEY);
  Reflect.deleteProperty(globalThis, HTML_INTEROP_FLUSH_KEY);
  Reflect.deleteProperty(globalThis, HTML_INTEROP_PEEK_KEY);
  Reflect.deleteProperty(globalThis, HTML_INTEROP_DETACH_KEY);
  Reflect.deleteProperty(globalThis, HTML_INTEROP_RESTORE_CONSOLE_KEY);
};

/**
 * Transfer startup logs and exceptions to the specified plugins.
 * @param plugins Plugins receiving buffered records.
 * @returns Whether takeover completed and the number of transferred records.
 */
export const takeOverHtmlInteropWithPlugins = async (plugins: readonly LoglinePlugin[]): Promise<TakeOverResult> => {
  const state = (globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState })[HTML_INTEROP_GLOBAL_KEY];
  if (!state) {
    return { taken: false, flushedCount: 0 };
  }
  // Capture and buffer consumption have separate lifecycles; detached buffers can still transfer.
  detachHtmlInteropCapture();

  const records = await mergeRecords();
  await notifyPlugins(records, plugins);

  destroyHtmlInteropCache(state);

  return { taken: true, flushedCount: records.length };
};
