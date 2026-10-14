# Logline v2

English | [简体中文](./README.zh-CN.md)

Structured frontend logging with TypeScript, Vite integration, IndexedDB persistence, and startup error capture.

**v2 is experimental and lives on the [`v2` branch](https://github.com/tellok/logline/tree/v2).** The default branch remains v1. Unqualified `npm install logline` and `pnpm add logline` continue to resolve v1 under `latest`. v2 is a rewrite and does not implement the v1 constructor or storage protocol API.

## Installation

```sh
# Stable v1
npm install logline
pnpm add logline

# Experimental v2, after its first npm prerelease is published
npm install logline@next
pnpm add logline@next
```

The initial v2 version is `2.0.0-alpha.0`. This branch provides source and release configuration; creating the branch does not publish a package. Before an npm prerelease exists, clone this branch and run `pnpm install && pnpm pack`, then install the resulting tarball. Development requires Node.js 22.12 or later and pnpm 10.20.0.

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

The Vite peer range is `^6.2.1 || ^7.0.0 || ^8.0.0`. Higher Vite versions also require a compatible Node.js version.

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

Declare the experimental Logline version in both `peerDependencies` and `devDependencies`, for example `2.0.0-alpha.0`. Keep `logline` external in library builds so the consuming application provides one instance. If you use the Vite plugin while building a library, explicitly set `logPrefixMacro: false` and keep `indexedDB: false`; the final application owns attribution and persistence.

## Development and releases

```sh
pnpm install
pnpm run type-check
pnpm run lint
pnpm run test
pnpm run build
pnpm pack

# Maintainers: publish only to the experimental channel.
pnpm run release:next
```

`publishConfig.tag` is `next`. The publish guard requires the `v2` branch, a `2.x.x-alpha.N`, `beta.N`, or `rc.N` version, and the `next` tag. The release command explicitly selects `v2` as pnpm's publish branch. Publish locally with an authenticated npm account. The branch CI verifies changes without publishing. Keep `latest` on v1 until a separate stable-v2 release decision.

## License

[MIT](./LICENSE).
