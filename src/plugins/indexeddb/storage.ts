import pkg from '../../../package.json';
import { getLoglineConfig, registerAutomaticLoglinePlugin } from '../../core/config';
import { LOG_LEVEL_INDEX, type LogLevelName } from '../../core/constants';
import { type LogRecord, type LogTimestamp, type LoglinePlugin } from '../../core/types';
import { safeStringify } from '../../core/utils';
import { takeOverHtmlInteropWithPlugins } from '../../html-interop/html-interop-takeover';
import { detachHtmlInteropCapture } from '../../html-interop/html-interop-shared';
import { resolveIndexedDBDatabaseName } from './database-name';

export interface IndexedDBLoggingOptions {
  /**
   * Explicit name; otherwise isolate by Vite base, falling back to logline.
   */
  readonly databaseName?: string;
  /**
   * Object store name; defaults to records.
   */
  readonly storeName?: string;
  /**
   * Maximum retained records; defaults to 100000.
   */
  readonly maxEntries?: number;
}

export interface IndexedDBLogRecord {
  readonly id: number;
  readonly level: number;
  readonly message: string;
}

export interface IndexedDBLoggingPlugin extends LoglinePlugin {
  /**
   * Retrieve recent log records.
   * @param count Requested record count; defaults to 100.
   * @param query Query filters.
   */
  getLogs(count?: number, query?: IndexedDBQueryOptions): Promise<IndexedDBLogRecord[]>;
  /** Stop global error listeners and close the database connection. */
  dispose(): void;
}

const DUPLICATE_AUTOMATIC_PLUGIN_WARNING =
  '[logline:indexeddb] Vite already enabled IndexedDB; createIndexedDBLoggingPlugin() will reuse the existing instance and ignore supplied options.';

let automaticIndexedDBPlugin: IndexedDBLoggingPlugin | undefined;
let removeAutomaticIndexedDBPlugin: (() => void) | undefined;
let hasWarnedAutomaticPluginReuse = false;
let isWarningAutomaticPluginReuse = false;

/**
 * Warn once about repeated creation through native console, bypassing Logline dispatch.
 */
const warnAutomaticPluginReuse = (): void => {
  if (hasWarnedAutomaticPluginReuse || isWarningAutomaticPluginReuse) return;
  hasWarnedAutomaticPluginReuse = true;
  isWarningAutomaticPluginReuse = true;
  try {
    console.warn(DUPLICATE_AUTOMATIC_PLUGIN_WARNING);
  } catch {
    // Diagnostics must not interrupt creation or reenter log dispatch.
  } finally {
    isWarningAutomaticPluginReuse = false;
  }
};

const getDbVersion = (versionString: string): number => {
  const [major, minor, patch] = versionString.split('.').map(Number);
  return (major || 0) * 1000000 + (minor || 0) * 1000 + (patch || 0);
};

// Primary key encoding: sequence slots per millisecond.
const SEQUENCE_CAPACITY = 100;
// Primary key encoding: suffix retries per sequence slot.
const TAIL_CAPACITY = 10;
// Weight of the millisecond component for timestamp encoding and decoding.
const KEY_MULTIPLIER = SEQUENCE_CAPACITY * TAIL_CAPACITY; // 1000
const WARN_PREFIX = '*logline* indexeddb: ';

/**
 * Generate ordered IDs from millisecond timestamps:
 * - ID = timestamp(ms) * 100 + sequence * 10 + tail
 * - Keep at most 100 records per millisecond (sequence 0-99); discard excess records.
 * - Tail retries resolve key collisions (0-9) and reset for each millisecond.
 * - Use integers to avoid floating-point precision problems.
 */
const generateId = (timestamp: LogTimestamp, tail: number): number | undefined => {
  const msTimestamp = Math.trunc(timestamp.epochMs);
  const currentSequence = timestamp.sequence;
  if (currentSequence > SEQUENCE_CAPACITY - 1) return undefined;
  return msTimestamp * KEY_MULTIPLIER + currentSequence * TAIL_CAPACITY + tail;
};

const toPromise = <T>(request: IDBRequest<T>): Promise<T> => {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
  });
};

const waitTransaction = (transaction: IDBTransaction): Promise<void> => {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('indexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('indexedDB transaction aborted'));
  });
};

const openDatabase = async (
  databaseName: string,
  storeName: string,
  onVersionChange?: () => void,
): Promise<IDBDatabase | undefined> => {
  if (typeof indexedDB === 'undefined') return undefined;
  const versionStr = pkg.version;
  const version = getDbVersion(versionStr);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(storeName)) {
        db.deleteObjectStore(storeName);
      }
      const store = db.createObjectStore(storeName, { keyPath: 'id' });
      store.createIndex('level', 'level', { unique: false });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        onVersionChange?.();
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
  });
};

const pruneExcess = async (db: IDBDatabase, storeName: string, maxEntries: number): Promise<void> => {
  if (maxEntries <= 0) return;
  const tx = db.transaction(storeName, 'readwrite');
  const done = waitTransaction(tx);
  const store = tx.objectStore(storeName);
  const total = await toPromise(store.count());
  if (total > maxEntries) {
    const needDelete = total - maxEntries;
    await new Promise<void>((resolve, reject) => {
      let removed = 0;
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (removed < needDelete) {
          cursor.delete();
          removed += 1;
          cursor.continue();
          return;
        }
        resolve();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('indexedDB cleanup failed'));
    });
  }
  await done;
};

const persistLog = async (
  db: IDBDatabase,
  storeName: string,
  record: IndexedDBLogRecord,
  maxEntries: number | undefined,
): Promise<void> => {
  const tx = db.transaction(storeName, 'readwrite');
  const done = waitTransaction(tx);
  const store = tx.objectStore(storeName);
  const addPromise = toPromise(store.add(record));
  try {
    await addPromise;
    await done;
  } catch (error) {
    await done.catch(() => undefined);
    throw error;
  }
  if (maxEntries !== undefined) {
    await pruneExcess(db, storeName, maxEntries);
  }
};

export interface IndexedDBQueryOptions {
  /**
   * Inclusive start timestamp.
   */
  from?: number;
  /**
   * Inclusive end timestamp.
   */
  to?: number;
  /**
   * Log level filter.
   */
  level?: LogLevelName;
}

const queryLogs = async (
  db: IDBDatabase,
  storeName: string,
  count: number,
  query?: IndexedDBQueryOptions,
): Promise<IndexedDBLogRecord[]> => {
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const results: IndexedDBLogRecord[] = [];

  // Construct the time range.
  let range: IDBKeyRange | undefined;
  // Sequence ranges from 0 to 99; suffix ranges from 0 to 9.
  const fromKey = query?.from !== undefined ? Math.trunc(query.from) * KEY_MULTIPLIER : undefined;
  const toKey =
    query?.to !== undefined
      ? Math.trunc(query.to) * KEY_MULTIPLIER + (SEQUENCE_CAPACITY - 1) * TAIL_CAPACITY + (TAIL_CAPACITY - 1)
      : undefined;

  if (fromKey !== undefined && toKey !== undefined) {
    range = IDBKeyRange.bound(fromKey, toKey);
  } else if (fromKey !== undefined) {
    range = IDBKeyRange.lowerBound(fromKey);
  } else if (toKey !== undefined) {
    range = IDBKeyRange.upperBound(toKey);
  }

  return new Promise((resolve, reject) => {
    // IndexedDB permits only one index per cursor.
    // A level index cannot directly preserve reverse chronological order.
    // Choose chronological scanning:
    // 1. Without a level filter, use the time-ordered primary key and key range.
    // 2. With a level filter, keep primary-key time ordering and filter levels in memory.
    //    Return the most recent matching records rather than the earliest matches.
    const request = store.openCursor(range, 'prev');

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && results.length < count) {
        const record = cursor.value as IndexedDBLogRecord;
        // Filter the level in memory.
        const queryLevel = query?.level ? LOG_LEVEL_INDEX[query.level] : undefined;
        if (queryLevel === undefined || record.level === queryLevel) {
          results.push(record);
        }
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error ?? new Error('indexedDB query failed'));
  });
};

/**
 * Decode keys into millisecond timestamps without exposing ordering suffixes to consumers.
 */
const normalizeLogIds = (records: IndexedDBLogRecord[]): IndexedDBLogRecord[] => {
  return records.map((record) => {
    const timestampMs = Math.trunc(record.id / KEY_MULTIPLIER);
    return {
      ...record,
      id: timestampMs,
    };
  });
};

/**
 * Retrieve logs from IndexedDB without retaining a plugin instance.
 * @param count Requested record count; defaults to 100.
 * @param query Query filters for time range and level.
 */
export const getLogs = async (count = 100, query?: IndexedDBQueryOptions): Promise<IndexedDBLogRecord[]> => {
  const databaseName = resolveIndexedDBDatabaseName(undefined);
  const storeName = DEFAULT_STORE_NAME;
  try {
    const db = await openDatabase(databaseName, storeName);
    if (!db) return [];
    const logs = await queryLogs(db, storeName, count, query);
    db.close();
    return normalizeLogIds(logs);
  } catch (error) {
    console.error('logline: failed to get logs from indexedDB', error);
    return [];
  }
};

const DEFAULT_STORE_NAME = 'records';
const DEFAULT_MAX_ENTRIES = 100000;
const GLOBAL_ERROR_SCOPE = '[global error]';
const GLOBAL_UNHANDLED_REJECTION_SCOPE = '[global unhandledrejection]';
let lastOverflowWarnMs = -1;
let lastRetryWarnMs = -1;

/**
 * Convert a global exception payload into message text.
 * @param payload Value carried by an error or unhandledrejection event.
 * @param fallback Fallback text when no valid content is available.
 */
const normalizeGlobalErrorMessage = (payload: unknown, fallback: string): string => {
  if (payload instanceof Error) {
    return payload.message || fallback;
  }
  if (typeof payload === 'string') {
    return payload || fallback;
  }
  if (payload === undefined) return fallback;
  return safeStringify(payload);
};

/**
 * Construct a global error record for storage without repeating console output.
 * @param payload Global exception payload.
 * @param explicitMessage Message explicitly supplied by the browser event.
 * @param fallback Fallback text when no valid exception value exists.
 * @param scope Log prefix identifying the exception source.
 */
const createGlobalErrorRecord = (
  payload: unknown,
  explicitMessage: string | undefined,
  fallback: string,
  scope: string,
): LogRecord => {
  const message = explicitMessage || normalizeGlobalErrorMessage(payload, fallback);
  const params = payload === undefined || payload === message ? [] : [payload];
  return {
    level: 'ERROR',
    args: [message, ...params],
    formattedArgs: [scope, message, ...params],
    scope,
    messageText: message,
    messageArgs: params,
    timestamp: getLoglineConfig().timeProvider.now(),
  };
};

/**
 * Install independent global error listeners for the plugin.
 * @param persist Callback persisting global errors directly.
 * @returns Cleanup function removing all listeners.
 */
const installGlobalErrorHooks = (persist: (record: LogRecord) => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const errorHandler = (event: ErrorEvent): void => {
    persist(createGlobalErrorRecord(event.error, event.message, 'Unknown error', GLOBAL_ERROR_SCOPE));
  };
  const rejectionHandler = (event: PromiseRejectionEvent): void => {
    persist(createGlobalErrorRecord(event.reason, undefined, 'Unhandled rejection', GLOBAL_UNHANDLED_REJECTION_SCOPE));
  };
  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', rejectionHandler);
  return () => {
    window.removeEventListener('error', errorHandler);
    window.removeEventListener('unhandledrejection', rejectionHandler);
  };
};

/**
 * Create a plugin persisting logs to IndexedDB.
 * @param options Database, store, and retention options.
 */
const createIndexedDBLoggingPluginInstance = (
  options: IndexedDBLoggingOptions,
  onClose: () => void = () => undefined,
): IndexedDBLoggingPlugin => {
  const databaseName = resolveIndexedDBDatabaseName(options.databaseName);
  const storeName = options.storeName ?? DEFAULT_STORE_NAME;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let databasePromise: Promise<IDBDatabase | undefined> | undefined;
  let htmlInteropTransferPromise: Promise<void> = Promise.resolve();
  let isClosed = false;
  let removeGlobalErrorHooks = (): void => undefined;

  const closePlugin = (): void => {
    if (isClosed) return;
    isClosed = true;
    removeGlobalErrorHooks();
    onClose();
    databasePromise
      ?.then((database) => {
        database?.close();
      })
      .catch(() => undefined);
  };

  const ensureDatabase = (): Promise<IDBDatabase | undefined> => {
    if (isClosed) return Promise.resolve(undefined);
    if (!databasePromise) {
      databasePromise = openDatabase(databaseName, storeName, () => {
        closePlugin();
      }).catch(() => undefined);
    }
    return databasePromise;
  };

  const plugin: IndexedDBLoggingPlugin = {
    name: 'logline-indexeddb',
    onLog: async (record) => {
      if (isClosed) return;
      try {
        const db = await ensureDatabase();
        if (!db) return;
        const message = record.formattedArgs.map((item) => safeStringify(item)).join(' ');
        const msTimestamp = Math.trunc(record.timestamp.epochMs);
        const sequence = record.timestamp.sequence;
        if (sequence > SEQUENCE_CAPACITY - 1) {
          if (lastOverflowWarnMs !== msTimestamp) {
            console.warn(`${WARN_PREFIX}More than 100 logs in one millisecond; subsequent records will be discarded`);
            lastOverflowWarnMs = msTimestamp;
          }
          return;
        }

        let tail = 0;
        let wrote = false;
        while (tail <= TAIL_CAPACITY - 1 && !wrote) {
          const id = generateId(record.timestamp, tail);
          if (id === undefined) return;
          const entry: IndexedDBLogRecord = {
            id,
            level: LOG_LEVEL_INDEX[record.level],
            message,
          };
          try {
            await persistLog(db, storeName, entry, maxEntries);
            wrote = true;
          } catch (error) {
            const isConstraintError = error instanceof DOMException && error.name === 'ConstraintError';
            if (isConstraintError && tail < TAIL_CAPACITY - 1) {
              if (lastRetryWarnMs !== msTimestamp) {
                console.warn(
                  `${WARN_PREFIX}Primary key collision; retrying with another suffix. Further collisions in this millisecond will not repeat this warning`,
                );
                lastRetryWarnMs = msTimestamp;
              }
              tail += 1;
              continue;
            }
            if (isConstraintError) {
              console.warn(`${WARN_PREFIX}Key collision after 10 suffix attempts; record discarded`, error);
              return;
            }
            throw error;
          }
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'InvalidStateError') {
          closePlugin();
          return;
        }
        console.error('logline-indexeddb: failed to persist log', error);
      }
    },
    getLogs: async (count = 100, query) => {
      await htmlInteropTransferPromise;
      if (isClosed) return [];
      try {
        const db = await ensureDatabase();
        if (!db) return [];
        const logs = await queryLogs(db, storeName, count, query);
        return normalizeLogIds(logs);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'InvalidStateError') {
          closePlugin();
          return [];
        }
        console.error('logline-indexeddb: failed to get logs', error);
        return [];
      }
    },
    dispose: closePlugin,
  };

  // Expose a convenience entry on globalThis for browser console access.
  (globalThis as Record<string, unknown>).__LOGLINE_GET_LOGS__ = plugin.getLogs;

  // Stop startup capture synchronously before installing plugin error listeners to avoid duplicates.
  detachHtmlInteropCapture();
  removeGlobalErrorHooks = installGlobalErrorHooks((record) => {
    try {
      const pending = plugin.onLog?.(record);
      if (pending) {
        pending.catch(() => undefined);
      }
    } catch {
      // Error handlers must not throw or write to console, which could cause recursive errors.
    }
  });

  // Transfer the buffer only to this persistence instance to avoid duplicate startup consumption.
  htmlInteropTransferPromise = takeOverHtmlInteropWithPlugins([plugin])
    .then(() => undefined)
    .catch((error: unknown) => {
      console.error('logline-indexeddb: failed to transfer html interop logs', error);
    });

  return plugin;
};

/**
 * Create a plugin persisting logs to IndexedDB.
 * Reuse the automatic instance when enabled by Vite to avoid duplicate listeners and writes.
 * @param options Database, store, and retention options.
 */
export const createIndexedDBLoggingPlugin = (options: IndexedDBLoggingOptions = {}): IndexedDBLoggingPlugin => {
  if (automaticIndexedDBPlugin) {
    warnAutomaticPluginReuse();
    return automaticIndexedDBPlugin;
  }
  return createIndexedDBLoggingPluginInstance(options);
};

/**
 * Install the single automatic IndexedDB plugin from a module injected by loglineVitePlugin.
 * @param options Database, store, and retention options.
 * @returns Newly installed or existing automatic plugin instance.
 */
export const installIndexedDBLoggingPluginFromVite = (
  options: IndexedDBLoggingOptions = {},
): IndexedDBLoggingPlugin => {
  if (automaticIndexedDBPlugin) return automaticIndexedDBPlugin;

  const plugin = createIndexedDBLoggingPluginInstance(options, () => {
    removeAutomaticIndexedDBPlugin?.();
    removeAutomaticIndexedDBPlugin = undefined;
    if (automaticIndexedDBPlugin === plugin) automaticIndexedDBPlugin = undefined;
  });
  automaticIndexedDBPlugin = plugin;
  hasWarnedAutomaticPluginReuse = false;
  removeAutomaticIndexedDBPlugin = registerAutomaticLoglinePlugin(plugin);
  return plugin;
};
