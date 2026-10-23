import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  configureLogline,
  getLoglineConfig,
  resetLoglineConfig,
  type LogRecord,
  type LoglinePlugin,
} from '../../core/config';
import {
  HTML_INTEROP_FLUSH_KEY,
  HTML_INTEROP_GLOBAL_KEY,
  type HtmlInteropRecord,
} from '../../html-interop/html-interop-shared';
import {
  createIndexedDBLoggingPlugin,
  installIndexedDBLoggingPluginFromVite,
  type IndexedDBLoggingPlugin,
} from './storage';

import { IDBKeyRange as FakeIDBKeyRange, indexedDB as fakeIndexedDB } from 'fake-indexeddb';

const assignIndexedDB = (): void => {
  globalThis.indexedDB = fakeIndexedDB;
  globalThis.IDBKeyRange = FakeIDBKeyRange;
};

let installedAutomaticPlugin: IndexedDBLoggingPlugin | undefined;

const readAllRecords = async (dbName: string, storeName: string): Promise<unknown[]> => {
  const openReq = indexedDB.open(dbName);
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    openReq.onsuccess = () => resolve(openReq.result);
    openReq.onerror = () => reject(openReq.error ?? new Error('open database failed'));
  });
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const getAllReq = store.getAll();
  const result = await new Promise<unknown[]>((resolve, reject) => {
    getAllReq.onsuccess = () => resolve(getAllReq.result);
    getAllReq.onerror = () => reject(getAllReq.error ?? new Error('getAll failed'));
  });
  db.close();
  return result;
};

const encodeId = (ms: number, sequence = 0, tail = 0): number => ms * 1000 + sequence * 10 + tail;

const createRecord = (level: LogRecord['level'], message: string, time: number, sequence = 0): LogRecord => {
  return {
    level,
    args: [message],
    formattedArgs: [message],
    scope: undefined,
    messageText: message,
    messageArgs: [],
    timestamp: {
      epochMs: time,
      sequence,
      stableTimeMs: time + sequence * 0.000001,
    },
  };
};

describe('createIndexedDBLoggingPlugin', () => {
  beforeEach(() => {
    resetLoglineConfig();
    assignIndexedDB();
    (globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: undefined })[HTML_INTEROP_GLOBAL_KEY] = undefined;
    (globalThis as { [HTML_INTEROP_FLUSH_KEY]?: undefined })[HTML_INTEROP_FLUSH_KEY] = undefined;
  });

  afterEach(() => {
    installedAutomaticPlugin?.dispose();
    installedAutomaticPlugin = undefined;
    resetLoglineConfig();
    vi.unstubAllGlobals();
  });

  test('automatic Vite instance survives configuration updates and warns once on manual reuse', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    installedAutomaticPlugin = installIndexedDBLoggingPluginFromVite({
      databaseName: 'test-vite-auto-indexeddb',
    });
    const businessPlugin: LoglinePlugin = {
      name: 'test-business-plugin',
    };

    configureLogline({
      plugins: [businessPlugin],
    });
    expect(getLoglineConfig().plugins).toEqual([installedAutomaticPlugin, businessPlugin]);

    const reusedPlugin = createIndexedDBLoggingPlugin({
      databaseName: 'ignored-manual-database',
    });
    configureLogline({
      plugins: [businessPlugin, reusedPlugin],
    });
    createIndexedDBLoggingPlugin();

    expect(reusedPlugin).toBe(installedAutomaticPlugin);
    expect(getLoglineConfig().plugins).toEqual([installedAutomaticPlugin, businessPlugin]);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('will reuse the existing instance'));
    warnSpy.mockRestore();
  });

  test('allows manual creation, configuration, and writes without an automatic instance', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const plugin = createIndexedDBLoggingPlugin({
      databaseName: 'test-manual-with-vite-disabled',
    });

    const configured = configureLogline({
      plugins: [plugin],
    });
    await configured.plugins[0]?.onLog?.(createRecord('LOG', 'manual-enabled', 11));

    const rows = await readAllRecords('test-manual-with-vite-disabled', 'records');
    expect(configured.plugins).toEqual([plugin]);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { message: string }).message).toBe('manual-enabled');
    expect(warnSpy).not.toHaveBeenCalled();
    plugin.dispose();
    warnSpy.mockRestore();
  });

  test('writes logs with default options', async () => {
    const plugin = createIndexedDBLoggingPlugin();
    const record = createRecord('LOG', 'hello', 1);
    await plugin.onLog?.(record);

    const rows = await readAllRecords('logline', 'records');
    expect(rows).toHaveLength(1);
    const stored = rows[0] as { message: string; level: number; id: number };
    expect(stored.message).toBe('hello');
    expect(stored.level).toBe(2); // LOG
    expect(stored.id).toBe(encodeId(1));
  });

  test('persists onLog records without intercepting ordinary console after initialization', async () => {
    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const plugin = createIndexedDBLoggingPlugin({
      databaseName: 'test-ignore-console-after-install',
    });

    console.debug('plain-console-debug');

    console.log('plain-console-log');
    console.warn('plain-console-warn');
    console.error('plain-console-error');

    expect(await plugin.getLogs(10)).toEqual([]);

    await plugin.onLog?.(createRecord('LOG', 'logline-record', 12));
    const rows = await plugin.getLogs(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe('logline-record');
    consoleSpies.forEach((spy) => spy.mockRestore());
    plugin.dispose();
  });

  test('transfers startup HTML records when the plugin is created', async () => {
    const record = createRecord('ERROR', 'html-error', 10);
    const htmlRecord: HtmlInteropRecord = {
      ...record,
      id: '10-0',
      scope: '[html]',
      formattedArgs: ['[html]', 'html-error'],
    };
    const state = {
      records: [htmlRecord],
      detached: true,
    };
    (globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: typeof state })[HTML_INTEROP_GLOBAL_KEY] = state;
    (globalThis as { [HTML_INTEROP_FLUSH_KEY]?: () => Promise<readonly HtmlInteropRecord[]> })[HTML_INTEROP_FLUSH_KEY] =
      async () => {
        const records = [...state.records];
        state.records.splice(0, state.records.length);
        return records;
      };

    const plugin = createIndexedDBLoggingPlugin({
      databaseName: 'test-html-interop-auto-transfer',
    });
    const rows = await plugin.getLogs(10);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe('[html] html-error');
    expect((globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: typeof state })[HTML_INTEROP_GLOBAL_KEY]).toBeUndefined();
    expect((globalThis as { [HTML_INTEROP_FLUSH_KEY]?: unknown })[HTML_INTEROP_FLUSH_KEY]).toBeUndefined();
  });

  test('persists independently captured global errors with source prefixes and no console output', async () => {
    const eventTarget = new EventTarget();
    vi.stubGlobal('window', eventTarget);
    const consoleSpies = [
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    const plugin = createIndexedDBLoggingPlugin({
      databaseName: 'test-global-errors',
    });
    const globalError = new Error('global-error-object');
    const errorEvent = new Event('error');
    Object.defineProperties(errorEvent, {
      error: { value: globalError },
      message: { value: 'global-error-message' },
    });
    const rejectionError = new Error('global-rejection-object');
    const rejectionEvent = new Event('unhandledrejection');
    Object.defineProperty(rejectionEvent, 'reason', { value: rejectionError });

    eventTarget.dispatchEvent(errorEvent);
    eventTarget.dispatchEvent(rejectionEvent);

    await vi.waitFor(async () => {
      const rows = await plugin.getLogs(10);
      expect(rows).toHaveLength(2);
    });
    const rows = await plugin.getLogs(10);
    expect(rows.map((row) => row.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('[global error] global-error-message'),
        expect.stringContaining('[global unhandledrejection] global-rejection-object'),
      ]),
    );
    expect(rows.every((row) => row.level === 4)).toBe(true);
    const errorRow = rows.find((row) => row.message.startsWith('[global error]'));
    const rejectionRow = rows.find((row) => row.message.startsWith('[global unhandledrejection]'));
    expect(errorRow?.message).toContain('"message":"global-error-object"');
    expect(errorRow?.message).toContain('"name":"Error"');
    expect(errorRow?.message).toContain('"stack":');
    expect(rejectionRow?.message).toContain('"message":"global-rejection-object"');
    expect(rejectionRow?.message).toContain('"name":"Error"');
    expect(rejectionRow?.message).toContain('"stack":');
    consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());

    plugin.dispose();
    eventTarget.dispatchEvent(errorEvent);
    consoleSpies.forEach((spy) => spy.mockRestore());
  });

  test('retains the newest records when maxEntries is exceeded', async () => {
    const plugin = createIndexedDBLoggingPlugin({
      databaseName: 'test-logs-2',
      storeName: 'records',
      maxEntries: 1,
    });
    await plugin.onLog?.(createRecord('LOG', 'first', 1));
    await plugin.onLog?.(createRecord('LOG', 'second', 2));

    const rows = await readAllRecords('test-logs-2', 'records');
    expect(rows).toHaveLength(1);
    const stored = rows[0] as { message: string; id: number };
    expect(stored.message).toBe('second');
    expect(stored.id).toBe(encodeId(2));
  });

  test('persists WARN records without color control codes', async () => {
    const plugin = createIndexedDBLoggingPlugin({
      databaseName: 'test-logs-3',
    });
    await plugin.onLog?.(createRecord('WARN', 'warn-message', 3));

    const rows = await readAllRecords('test-logs-3', 'records');
    expect(rows).toHaveLength(1);
    const stored = rows[0] as { message: string; level: number };
    expect(stored.message).toBe('warn-message');
    expect(stored.level).toBe(3); // WARN
    expect(/\u001B/.test(stored.message)).toBe(false);
  });

  test('discards records beyond 100 in one millisecond', async () => {
    const plugin = createIndexedDBLoggingPlugin({
      databaseName: 'test-logs-4',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 101; i += 1) {
      // Repeated writes in the same millisecond are discarded after 100 records.
      await plugin.onLog?.(createRecord('LOG', `msg-${i}`, 4, i));
    }

    const rows = await readAllRecords('test-logs-4', 'records');
    expect(rows).toHaveLength(100);
    const last = rows[rows.length - 1] as { id: number; message: string };
    expect(last.id).toBe(encodeId(4, 99)); // 4 * 1000 + 99 * 10 + 0
    expect(last.message).toBe('msg-99');
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  test('retries key collisions with increasing suffixes', async () => {
    const plugin = createIndexedDBLoggingPlugin({
      databaseName: 'test-logs-5',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = createRecord('LOG', 'first', 5, 0);
    const duplicated = createRecord('LOG', 'second', 5, 0);
    await plugin.onLog?.(first);
    await plugin.onLog?.(duplicated);

    const rows = await readAllRecords('test-logs-5', 'records');
    expect(rows).toHaveLength(2);
    const sorted = rows.sort((a, b) => {
      return (a as { id: number }).id - (b as { id: number }).id;
    }) as { id: number; message: string }[];
    expect(sorted[0].id).toBe(encodeId(5)); // 5 * 1000 + 0 * 10 + 0
    expect(sorted[0].message).toBe('first');
    expect(sorted[1].id).toBe(encodeId(5, 0, 1)); // suffix +1
    expect(sorted[1].message).toBe('second');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('getLogs decodes IDs to milliseconds while preserving result order', async () => {
    const plugin = createIndexedDBLoggingPlugin({
      databaseName: 'test-logs-6',
    });
    // Two records share a normalized millisecond ID but retain their storage order.
    await plugin.onLog?.(createRecord('LOG', 'first', 6, 0));
    await plugin.onLog?.(createRecord('LOG', 'second', 6, 1));

    const rows = await plugin.getLogs?.(10);
    expect(rows).toHaveLength(2);
    expect(rows?.[0]?.id).toBe(6);
    expect(rows?.[1]?.id).toBe(6);
    expect(rows?.[0]?.message).toBe('second');
    expect(rows?.[1]?.message).toBe('first');
  });

  test('persists 1000 concurrent records without loss or duplicate IDs', async () => {
    const plugin = createIndexedDBLoggingPlugin({
      databaseName: 'test-logs-concurrency',
    });

    // Advance one millisecond per 50 records to avoid the per-millisecond limit.
    let currentTime = 1000000;
    const records: LogRecord[] = [];
    for (let i = 0; i < 1000; i++) {
      if (i > 0 && i % 50 === 0) {
        currentTime += 1;
      }
      // Simulate the core's increasing sequence within a millisecond.
      const sequence = i % 50;
      records.push(createRecord('LOG', `msg-${i}`, currentTime, sequence));
    }

    // Concurrent writes.
    await Promise.all(records.map((r) => plugin.onLog?.(r)));

    const rows = await readAllRecords('test-logs-concurrency', 'records');
    expect(rows).toHaveLength(1000);

    const ids = rows.map((r) => (r as { id: number }).id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(1000);
  });
});
