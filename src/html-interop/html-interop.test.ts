import { IDBKeyRange as FakeIDBKeyRange, indexedDB as fakeIndexedDB } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createIndexedDBLoggingPlugin } from '../plugins/indexeddb/storage';
import {
  HTML_INTEROP_DETACH_KEY,
  HTML_INTEROP_FLUSH_KEY,
  HTML_INTEROP_GLOBAL_KEY,
  HTML_INTEROP_PEEK_KEY,
  HTML_INTEROP_RESTORE_CONSOLE_KEY,
  type HtmlInteropDetach,
  type HtmlInteropPeek,
  type HtmlInteropState,
} from './html-interop-shared';

const originalConsole = {
  debug: console.debug,
  error: console.error,
  log: console.log,
  warn: console.warn,
};

const clearInteropGlobals = (): void => {
  Reflect.deleteProperty(globalThis, HTML_INTEROP_GLOBAL_KEY);
  Reflect.deleteProperty(globalThis, HTML_INTEROP_FLUSH_KEY);
  Reflect.deleteProperty(globalThis, HTML_INTEROP_PEEK_KEY);
  Reflect.deleteProperty(globalThis, HTML_INTEROP_DETACH_KEY);
  Reflect.deleteProperty(globalThis, HTML_INTEROP_RESTORE_CONSOLE_KEY);
};

describe('HTML Interop capture lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    clearInteropGlobals();
  });

  afterEach(() => {
    const detach = (globalThis as { [HTML_INTEROP_DETACH_KEY]?: HtmlInteropDetach })[HTML_INTEROP_DETACH_KEY];
    detach?.();
    console.debug = originalConsole.debug;
    console.error = originalConsole.error;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    clearInteropGlobals();
    vi.unstubAllGlobals();
  });

  test('keeps capturing after Vue mount and window load until explicit takeover', async () => {
    const windowTarget = new EventTarget();
    const removeEventListener = vi.spyOn(windowTarget, 'removeEventListener');
    vi.stubGlobal('window', windowTarget);
    vi.stubGlobal('document', {
      querySelector: () => ({ hasAttribute: () => true }),
      readyState: 'complete',
    });
    console.log = vi.fn();
    console.warn = vi.fn();

    await import('./html-interop');
    const state = (globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState })[HTML_INTEROP_GLOBAL_KEY];
    if (!state) throw new Error('Expected HTML Interop to be installed');
    console.log('vue-mounted');
    windowTarget.dispatchEvent(new Event('load'));
    console.warn('after-load');

    expect(state.detached).toBe(false);
    expect(state.consoleBackup).toBeDefined();
    expect(state.records.map((record) => record.messageText)).toEqual(['vue-mounted', 'after-load']);
    expect(removeEventListener).not.toHaveBeenCalled();
    expect((globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState })[HTML_INTEROP_GLOBAL_KEY]).toBe(state);
  });

  test('retains the latest 1000 records without clearing the buffer on peek', async () => {
    const windowTarget = new EventTarget();
    vi.stubGlobal('window', windowTarget);
    console.log = vi.fn();

    await import('./html-interop');
    const state = (globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState })[HTML_INTEROP_GLOBAL_KEY];
    if (!state) throw new Error('Expected HTML Interop to be installed');
    for (let index = 0; index < 1005; index += 1) {
      console.log(`entry-${index}`);
    }
    const peek = (globalThis as { [HTML_INTEROP_PEEK_KEY]?: HtmlInteropPeek })[HTML_INTEROP_PEEK_KEY];
    if (!peek) throw new Error('Expected a read-only HTML Interop peek entry');

    const firstResult = await peek();
    const secondResult = await peek();

    expect(firstResult).toHaveLength(1000);
    expect(firstResult[0]?.messageText).toBe('entry-5');
    expect(firstResult.at(-1)?.messageText).toBe('entry-1004');
    expect(secondResult).toHaveLength(1000);
    expect(state.records).toHaveLength(1000);
  });

  test('deduplicates full error content only at capacity and keeps the latest record', async () => {
    const windowTarget = new EventTarget();
    vi.stubGlobal('window', windowTarget);
    console.error = vi.fn();
    console.log = vi.fn();

    await import('./html-interop');
    const state = (globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState })[HTML_INTEROP_GLOBAL_KEY];
    if (!state) throw new Error('Expected HTML Interop to be installed');
    const firstDuplicateError = new TypeError('duplicate error');
    firstDuplicateError.stack = 'TypeError: duplicate error\n    at start (dist/runtime.js:10:2)';
    const latestDuplicateError = new TypeError('duplicate error');
    latestDuplicateError.stack = 'TypeError: duplicate error\n    at start (dist/runtime.js:10:2)';
    console.error('duplicate error', firstDuplicateError);
    console.error('duplicate error', latestDuplicateError);
    const firstLocationError = new TypeError('location-sensitive error');
    firstLocationError.stack = 'TypeError: location-sensitive error\n    at start (dist/runtime.js:10:2)';
    const secondLocationError = new TypeError('location-sensitive error');
    secondLocationError.stack = 'TypeError: location-sensitive error\n    at start (dist/runtime.js:99:18)';
    console.error('location-sensitive error', firstLocationError);
    console.error('location-sensitive error', secondLocationError);
    console.error('[npm:@example/demo dist/app.js:10:2] plain string error');
    console.error('[npm:@example/demo dist/app.js:99:18] plain string error');
    console.error('plain object error', { stack: 'at start (dist/runtime.js:10:2)' });
    console.error('plain object error', { stack: 'at start (dist/runtime.js:99:18)' });
    for (let index = 0; index < 991; index += 1) {
      console.log(`entry-${index}`);
    }

    expect(state.records).toHaveLength(999);
    expect(state.records.filter((record) => record.level === 'ERROR')).toHaveLength(8);

    console.log('trigger-full');

    const errorRecords = state.records.filter((record) => record.level === 'ERROR');
    expect(state.records).toHaveLength(999);
    expect(errorRecords).toHaveLength(7);
    const duplicateErrorRecords = errorRecords.filter((record) => record.messageText === 'duplicate error');
    expect(duplicateErrorRecords).toHaveLength(1);
    expect(duplicateErrorRecords[0]?.args[1]).toBe(latestDuplicateError);
    expect(errorRecords.filter((record) => record.messageText === 'location-sensitive error')).toHaveLength(2);
    expect(errorRecords.some((record) => record.messageText?.includes('dist/app.js:10:2'))).toBe(true);
    expect(errorRecords.some((record) => record.messageText?.includes('dist/app.js:99:18'))).toBe(true);
    expect(errorRecords.filter((record) => record.messageText === 'plain object error')).toHaveLength(2);
  });

  test('keeps deduplicated errors and evicts the oldest non-error at capacity', async () => {
    const windowTarget = new EventTarget();
    vi.stubGlobal('window', windowTarget);
    console.error = vi.fn();
    console.log = vi.fn();

    await import('./html-interop');
    const state = (globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState })[HTML_INTEROP_GLOBAL_KEY];
    if (!state) throw new Error('Expected HTML Interop to be installed');
    console.error('[dist/boot.js:1:1] unique startup error');
    for (let index = 0; index < 999; index += 1) {
      console.log(`entry-${index}`);
    }
    console.log('overflow-entry');

    expect(state.records).toHaveLength(1000);
    expect(state.records.some((record) => record.messageText?.includes('unique startup error'))).toBe(true);
    expect(state.records.some((record) => record.messageText === 'entry-0')).toBe(false);
    expect(state.records.at(-1)?.messageText).toBe('overflow-entry');
  });

  test('restores console, removes startup listeners, and transfers the buffer on IndexedDB creation', async () => {
    const windowTarget = new EventTarget();
    const removeEventListener = vi.spyOn(windowTarget, 'removeEventListener');
    vi.stubGlobal('window', windowTarget);
    vi.stubGlobal('indexedDB', fakeIndexedDB);
    vi.stubGlobal('IDBKeyRange', FakeIDBKeyRange);
    console.error = vi.fn();

    await import('./html-interop');
    const state = (globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState })[HTML_INTEROP_GLOBAL_KEY];
    if (!state) throw new Error('Expected HTML Interop to be installed');
    const proxiedConsoleError = console.error;
    console.error('startup-error');
    const startupGlobalError = new Error('startup-global-error-object');
    const startupErrorEvent = new Event('error');
    Object.defineProperties(startupErrorEvent, {
      error: { value: startupGlobalError },
      message: { value: 'startup-global-error-message' },
    });
    const startupRejection = new Error('startup-global-rejection-object');
    const startupRejectionEvent = new Event('unhandledrejection');
    Object.defineProperty(startupRejectionEvent, 'reason', { value: startupRejection });
    windowTarget.dispatchEvent(startupErrorEvent);
    windowTarget.dispatchEvent(startupRejectionEvent);

    const cachedGlobalError = state.records.find((record) => record.scope === '[global error]');
    const cachedGlobalRejection = state.records.find((record) => record.scope === '[global unhandledrejection]');
    expect(cachedGlobalError?.level).toBe('ERROR');
    expect(cachedGlobalError?.args).toEqual(['startup-global-error-message', startupGlobalError]);
    expect(cachedGlobalError?.messageArgs).toEqual([startupGlobalError]);
    expect(cachedGlobalError).not.toHaveProperty('error');
    expect(cachedGlobalRejection?.level).toBe('ERROR');
    expect(cachedGlobalRejection?.args).toEqual(['startup-global-rejection-object', startupRejection]);
    expect(cachedGlobalRejection?.messageArgs).toEqual([startupRejection]);

    const plugin = createIndexedDBLoggingPlugin({
      databaseName: 'test-html-interop-lifecycle',
    });

    expect(state.detached).toBe(true);
    expect(console.error).not.toBe(proxiedConsoleError);
    expect(removeEventListener).toHaveBeenCalledWith('error', expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith('unhandledrejection', expect.any(Function));

    const rows = await plugin.getLogs(10);
    expect(rows.map((row) => row.message)).toContain('[html] startup-error');
    const globalErrorRow = rows.find((row) => row.message.startsWith('[global error] startup-global-error-message'));
    const globalRejectionRow = rows.find((row) =>
      row.message.startsWith('[global unhandledrejection] startup-global-rejection-object'),
    );
    expect(rows.every((row) => row.level === 4)).toBe(true);
    expect(globalErrorRow?.message).toContain('"message":"startup-global-error-object"');
    expect(globalErrorRow?.message).toContain('"name":"Error"');
    expect(globalErrorRow?.message).toContain('"stack":');
    expect(globalRejectionRow?.message).toContain('"message":"startup-global-rejection-object"');
    expect(globalRejectionRow?.message).toContain('"name":"Error"');
    expect(globalRejectionRow?.message).toContain('"stack":');
    expect((globalThis as { [HTML_INTEROP_GLOBAL_KEY]?: HtmlInteropState })[HTML_INTEROP_GLOBAL_KEY]).toBeUndefined();

    plugin.dispose();
  });
});
