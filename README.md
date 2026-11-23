# Logline

English | [简体中文](./README.zh-CN.md)

Local-first frontend logging for JavaScript and TypeScript: store logs on the client with IndexedDB, then let your application retrieve and report them on demand. Includes Vite integration and startup error capture.

> [!IMPORTANT]
> **This default branch contains the v2 beta.** For v1 installation and usage, see the [v1 README](https://github.com/tellok/logline/blob/v1/README.md). The preserved [v1 branch](https://github.com/tellok/logline/tree/v1) contains the previous default-branch implementation. v2 is a rewrite and does not implement the v1 constructor or storage protocol API.

## Installation

```sh
npm install logline@beta
pnpm add logline@beta
```

See [release status](https://www.npmjs.com/package/logline?activeTab=versions) for published versions. Development uses Node.js 24.22.1 LTS and pnpm 11.25.0 with automatic selection and advisory version checks. See the [workspace guide](./docs/workspace.md).

## Logging

```ts
import { configureLogline, DEBUG, ERROR, LOG, TRACE, WARN } from 'logline';

configureLogline({ throttle: 500 });
TRACE('Starting request');
DEBUG('Elapsed: %d ms', 42);
LOG('User: %o', { id: 'demo' });
WARN('Missing configuration');
ERROR('Request failed', new Error('Network unavailable'));
```

Supported levels, from lowest to highest: `TRACE`, `DEBUG`, `LOG`, `WARN`, `ERROR`. Console placeholders include `%s`, `%d`, `%i`, `%f`, `%o`, `%O`, and `%j`.

`configureLogline` merges supplied fields into the global configuration. `filter(record)` rejects records before console output and plugin dispatch. `throttle` accepts milliseconds, `false`, or `{ ms, key }`; its default key uses the first string argument. `plugins` extends processing with custom `install` and `onLog` hooks. `getLoglineConfig()` reads configuration and `resetLoglineConfig()` resets it.

```ts
configureLogline({
  filter: ({ messageText }) => !messageText?.includes('secret'),
  throttle: { ms: 500, key: ({ level, args }) => `${level}-${String(args[0])}` },
});
```

## Tags

Tags attach flat string key/value pairs to records, Sentry-style. Configure global tags and per-call tags on an input object; per-call entries win on conflicts. Keys must match `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`; values are non-empty strings of at most 256 characters and pass through masking (sensitive key names become `***`). A record keeps at most 16 entries. Tags persist alongside IndexedDB records and, when reported, become filterable, searchable and aggregatable `tags.*` fields in the Logs Explorer, with every pair indexed on the server.

```ts
configureLogline({ tags: { app: 'shop' } });
LOG({ message: 'Checkout finished', tags: { experiment: 'one-click' } });
```

Global tags can also be managed imperatively without replacing the rest of the set: `setTag(key, value)` adds or updates one entry, `setTags(object)` merges several, and `removeTag(key)` deletes one. These merge into the current configuration; a later `configureLogline({ tags })` still replaces the whole set.

```ts
import { removeTag, setTag, setTags } from 'logline';

setTag('release', '2.1.0');
setTags({ experiment: 'one-click', region: 'eu' });
removeTag('experiment');
```

For tags that apply to just one code path, wrap the work in `withScope`, Sentry-style. Records logged inside the callback merge scope tags between global and per-call tags; nested scopes apply outer-to-inner with inner entries winning. A synchronous callback detaches its scope on return or throw; an async callback keeps its scope until the returned promise settles (concurrent async scopes may share tags, as browsers lack AsyncLocalStorage). Tag APIs never throw into application code: invalid or hostile input is dropped silently, while exceptions raised by your own callback propagate unchanged.

```ts
import { LOG, withScope } from 'logline';

const result = await withScope(async (scope) => {
  scope.setTag('requestId', request.id);
  scope.setTags({ handler: 'checkout' });
  LOG('Request started'); // carries requestId and handler
  return handle(request);
});
```

## Upload to your own server

Install `logline-server-reporter@beta` alongside the matching `logline@beta` release. The reporter is optional: importing Logline alone sends nothing. Configure one reporter per destination using a project DSN. This example runs in a trusted application process:

```ts
import { configureLogline } from 'logline';
import { createLoglineServerReporter } from 'logline-server-reporter';

const reporter = createLoglineServerReporter({
  dsn: process.env.LOGLINE_DSN!,
  reporting: { sampleRate: 0.1, levelSampleRates: { ERROR: 1 } },
});
configureLogline({ plugins: [reporter] });
```

Create a project ingestion key in the admin API, then construct `https://<key>@<host>[/prefix]/<project-uuid>`. The DSN can only submit events to that project; it belongs to the project, not a member. A browser DSN is public: anyone who copies it can submit events. Use a separate key for your backend, and generate trusted audit events there. Browser uploads from any origin are accepted by default; set `LOGLINE_INGEST_ORIGINS` on the server to restrict them to exact origins. There is no implicit hosted endpoint, durable client queue, or upload of IndexedDB history. See the [reporting contract](./docs/reporting.md), [ingestion API](./docs/server-ingestion.md), [administration](./docs/server-admin.md), [Logs Explorer](./docs/server-explorer.md), [MCP tools](./docs/server-mcp.md), and [deployment and performance guide](./docs/server-operations.md).

## Vite integration

```ts
import { defineConfig } from 'vite';
import { loglineVitePlugin } from 'logline/vite-plugin';

export default defineConfig({
  plugins: [
    loglineVitePlugin({
      level: 'WARN',
      indexedDB: true,
      htmlInterop: { inline: true },
    }),
  ],
});
```

| Option                               | Default                 | Behavior                                                   |
| ------------------------------------ | ----------------------- | ---------------------------------------------------------- |
| `level`                              | Environment, then `LOG` | Marks lower-level calls as pure for removal in production  |
| `indexedDB`                          | `false`                 | Automatically installs persistence; accepts plugin options |
| `logPrefixMacro`                     | `true`                  | Adds source location and dependency package attribution    |
| `logPrefixMacro.includeFunctionName` | `true`                  | Adds the nearest named function                            |
| `logPrefixMacro.sourcemapRetrack`    | `true`                  | Uses available sourcemaps for source locations             |
| `logPrefixMacro.namespace`           | `undefined`             | Adds a label to application code                           |
| `htmlInterop`                        | Disabled                | Captures startup console output and global errors          |

The minimum build level is resolved from the explicit `level`, process `VITE_LOG_LEVEL`, Vite `.env*` files, then `LOG`. Prefixes are injected for string literals and template literals. npm dependencies receive their installed package name and published artifact location; application namespaces do not override dependency attribution.

The Vite peer range is `^5.2.8 || ^6.2.1 || ^7.0.0 || ^8.0.0`. Higher Vite versions also require a compatible Node.js version. Development dependency attribution uses native Rolldown transforms on Vite 8 and esbuild hooks on Vite 5/6/7; no optimizer configuration is required. CI tests packed-package consumers against the latest release of each supported Vite major (5–8).

### Keep logs locally and strip them in CI

Use `loglineVitePlugin()` and set `VITE_LOGLINE_ENABLE=false` in CI. Use `VITE_LOG_LEVEL` to select the minimum build level when logs are enabled.

```sh
VITE_LOG_LEVEL=TRACE pnpm exec vite build  # Local build with all Logline levels
VITE_LOGLINE_ENABLE=false pnpm exec vite build  # CI build with Logline calls stripped
```

The plugin resolves the explicit `enable` option first, then process `VITE_LOGLINE_ENABLE`, then Vite `.env*` files. The environment variable accepts `true` and `false` case-insensitively and defaults to `true` when unset. To use a CI mode, put `VITE_LOGLINE_ENABLE=false` in `.env.ci` and run `pnpm exec vite build --mode ci`. Set `loglineVitePlugin({ enable: false })` to disable logs directly in the Vite config.

Disabling logs erases statically recognized `TRACE`, `DEBUG`, `LOG`, `WARN`, and `ERROR` calls in application code and bundled dependencies, including evaluation of their arguments. Keep application side effects outside log arguments. This setting applies to `vite build`. Dynamic logger calls, native `console.*` calls, and separately enabled logging integrations are outside the build filter.

## Auto-import

```ts
import AutoImport from 'unplugin-auto-import/vite';
import { createLoglineAutoImport } from 'logline/auto-import';

// Add to the Vite plugins array.
AutoImport({ ...createLoglineAutoImport() });
```

`unplugin-auto-import` is optional and must be installed separately. `loglineAutoImportResolvers` is also exported.

## Persistence and startup capture

```ts
import { configureLogline, ERROR } from 'logline';
import { createIndexedDBLoggingPlugin } from 'logline/plugin/indexeddb';

const storage = createIndexedDBLoggingPlugin({ databaseName: 'app-logs', maxEntries: 5000 });
configureLogline({ plugins: [storage] });
ERROR('Request failed', new Error('Timeout'));
const errors = await storage.getLogs(50, { level: 'ERROR' });
// Release listeners and the database connection when no longer needed.
storage.dispose();
```

Without an explicit name, databases use the resolved Vite base: `logline` at the root or `logline:<base>` for a deployment subpath. Use the plugin instance to query explicitly named databases. The standalone `getLogs()` uses automatic naming.

HTML Interop is opt-in. It buffers up to 1,000 startup records until IndexedDB takes over, restores console methods, and transfers the buffer. After takeover, persistence records Logline calls and global `error` / `unhandledrejection` events; ordinary console calls are no longer collected. Importing the main entry alone does not install HTML Interop.

- [IndexedDB reference](./docs/indexeddb.md)
- [Click logging reference](./docs/click-log.md)
- [Migration and release policy](./docs/migration-v2.md)
- [中文完整参考](./README.zh-CN.md)

## Library authors

Declare the experimental Logline version in both `peerDependencies` and `devDependencies`, for example `2.0.0-beta.0`. Keep `logline` external in library builds so the consuming application provides one instance. If you use the Vite plugin while building a library, explicitly set `logPrefixMacro: false` and keep `indexedDB: false`; the final application owns attribution and persistence.

## Development and releases

The pnpm workspace contains the core `logline` library, the public `logline-server-reporter` uploader, and the self-hosted `logline-server`. Nx caches builds and checks. See the bilingual [workspace guide](./docs/workspace.md) for toolchain selection, commands, caching, and packaging.

```sh
pnpm install
pnpm run verify
pnpm changeset
```

Add a Changeset for an observable change and its Chinese summary in `.changeset/translations.json`. The lightweight default-branch workflow prepares a version PR without building the product. PR checks validate the newest merged result. Only a verified version-PR merge may build and publish a beta through npm trusted publishing in `release.yml`. The workflow builds once, validates the package, and publishes that same tarball with `--tag beta`.

See the bilingual [release-flow contract](./docs/release-flow.md) for permissions, source verification, storage, recovery, and external-contributor execution boundaries.

## License

[MIT](./LICENSE).
