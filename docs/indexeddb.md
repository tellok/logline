# IndexedDB plugin

[简体中文](./indexeddb.zh-CN.md) | [README](../README.md)

Import from `logline/plugin/indexeddb`. The plugin persists structured logs and global browser errors.

```ts
import { configureLogline, ERROR } from 'logline';
import { createIndexedDBLoggingPlugin } from 'logline/plugin/indexeddb';

const storage = createIndexedDBLoggingPlugin({ databaseName: 'app-logs', maxEntries: 5000 });
configureLogline({ plugins: [storage] });
ERROR('Request failed', new Error('Timeout'));
const logs = await storage.getLogs(50, { level: 'ERROR' });
storage.dispose();
```

| Option         | Default                | Purpose                  |
| -------------- | ---------------------- | ------------------------ |
| `databaseName` | Resolved automatically | Explicit database name   |
| `storeName`    | `records`              | Object store name        |
| `maxEntries`   | `100000`               | Maximum retained records |

Without an explicit name, resolution uses the Vite plugin's final base, runtime `import.meta.env.BASE_URL`, then `logline`. A root deployment uses `logline`; `/branches/demo/` uses `logline:/branches/demo`. URL bases contribute only their path, trailing slashes are removed, and unresolved dynamic placeholders are ignored. Page routes do not determine the database name.

## Automatic initialization

Final applications can enable `loglineVitePlugin({ indexedDB: true })` or pass an options object as `indexedDB`. Initialization is injected as an import into the application entry and participates in normal bundling and sourcemap composition. This feature is disabled by default and should stay disabled in library builds.

Later calls to `createIndexedDBLoggingPlugin()` reuse the automatic instance and warn once that supplied manual options are ignored. Later `configureLogline()` calls do not replace this automatic instance.

## Queries

`storage.getLogs(count?, query?)` queries that instance's database. The exported `getLogs(count?, query?)` selects the automatically named database and cannot query an explicitly named database. The default count is 100. Queries support `from`, `to`, and `level`; filtering happens during cursor scanning, so the requested count applies to matching records.

```ts
import { getLogs } from 'logline/plugin/indexeddb';

const errors = await getLogs(50, { level: 'ERROR' });
```

Inspect the actual database in browser developer tools under Application → IndexedDB.

## Capture and lifecycle

Writes queue while a connection or upgrade is pending. Each millisecond permits at most 100 records; collisions retry up to ten suffixes. A schema upgrade recreates the old store. Other open pages close their connection on `versionchange` and stop persisting, so their subsequent records are lost.

If HTML Interop is enabled, creating the plugin restores original console methods, detaches startup error listeners, transfers buffered records, and removes the startup globals. Queries wait for the transfer. The startup buffer retains up to 1,000 records; after reaching capacity, errors are deduplicated by full argument content, including stack locations, and non-error records are evicted first.

After initialization, ordinary console calls are not persisted. Logline calls and independent `error` / `unhandledrejection` listeners write records. Global errors use `[global error]` or `[global unhandledrejection]` prefixes without repeating console output. Error parameters preserve `name`, `message`, and `stack`. Call `dispose()` to remove listeners and close the database connection.
