---
name: logline
description: Add, configure, or debug structured frontend logging with experimental Logline v2. Covers application and npm library integration, log levels, Vite attribution and stripping, auto-import, IndexedDB persistence, and optional startup capture.
---

# Logline v2 integration

Read the [online documentation](https://tellok.github.io/logline/) or its [Simplified Chinese version](https://tellok.github.io/logline/zh/) for the released integration guides.

## Confirm the version

This Skill applies to experimental v2 only. Inspect package.json and confirm a 2.x prerelease is installed. Unqualified npm/pnpm installation still selects stable v1, whose constructor and storage protocol API differ from v2.

Install `logline@beta` explicitly. Before publication, install a tarball built from the default branch. Use `logline` in import paths.

## Applications and libraries

A final application installs Logline directly. An npm library declares the experimental version in both peerDependencies and devDependencies, for example `2.0.0-beta.0`, and keeps Logline external in its build. This lets the final application provide one compatible instance. Do not assume API compatibility between prerelease versions.

For library builds using `loglineVitePlugin`, explicitly set `logPrefixMacro: false` and keep `indexedDB: false`. The final application controls dependency attribution, database initialization, and HTML startup capture. Never hard-code a library's own package name or source locations into published log messages. Keep ordinary runtime dependencies external so the consumer can identify their actual package boundaries.

For strict peer validation, pnpm 9 uses `.npmrc`:

```ini
strict-peer-dependencies=true
auto-install-peers=true
```

pnpm 10/11 uses `pnpm-workspace.yaml`:

```yaml
packages:
  - '.'
strictPeerDependencies: true
autoInstallPeers: true
```

Preserve existing workspace package patterns. Overrides and Vite deduplication do not prove that the selected version satisfies every library's peer range.

## Log functions and runtime configuration

Levels increase in severity: TRACE, DEBUG, LOG, WARN, ERROR. Do not recommend the removed VERB level.

```ts
import { configureLogline, DEBUG, ERROR, LOG, TRACE, WARN } from 'logline';

configureLogline({ throttle: 500 });
TRACE('Request started');
DEBUG('Elapsed: %d ms', 42);
LOG('Response: %o', { status: 'ok' });
WARN('Configuration missing');
ERROR('Request failed', new Error('Timeout'));
```

Use string literals or template literals as the first argument when source-prefix injection is required. Runtime logging also accepts supported input objects, but the macro cannot inject a prefix into arbitrary message expressions. Console placeholders include `%s`, `%d`, `%i`, `%f`, `%o`, `%O`, and `%j`.

`configureLogline` merges supplied fields. A filter returning false rejects a record before console output and plugin dispatch. Throttling accepts milliseconds or `{ ms, key }`; false disables it. Without a custom key, the first string argument identifies duplicates.

```ts
configureLogline({
  filter: ({ messageText }) => !messageText?.includes('secret'),
  throttle: { ms: 500, key: ({ level, args }) => `${level}-${String(args[0])}` },
});
```

## Vite and auto-import

The Vite peer range supports majors 6, 7, and 8. Verify Node.js compatibility with the selected Vite version.

```ts
import { defineConfig } from 'vite';
import { loglineVitePlugin } from 'logline/vite-plugin';

export default defineConfig({
  plugins: [loglineVitePlugin({ level: 'WARN', indexedDB: true })],
});
```

Resolve the build level from explicit options, process VITE_LOG_LEVEL, merged Vite environment files, then LOG. Lower-level calls are removable during production builds. Prefix injection defaults to true. Application code uses source locations; npm dependencies use the nearest installed package.json and published artifact location. Existing npm prefixes are normalized rather than stacked. Sourcemaps restore application positions; dependency mappings must still identify the published artifact. A flattened dependency without retained metadata cannot reliably recover its original package identity.

Install unplugin-auto-import separately when needed:

```ts
import AutoImport from 'unplugin-auto-import/vite';
import { createLoglineAutoImport } from 'logline/auto-import';

AutoImport({ ...createLoglineAutoImport() });
```

`loglineAutoImportResolvers` is also exported.

## IndexedDB persistence

Persistence is optional. Final Vite applications can enable `indexedDB: true` or supply an options object. Initialization joins the application entry module graph and preserves sourcemap composition.

For explicit instance lifecycle control, leave automatic initialization disabled:

```ts
import { configureLogline } from 'logline';
import { createIndexedDBLoggingPlugin } from 'logline/plugin/indexeddb';

const storage = createIndexedDBLoggingPlugin({ databaseName: 'app-logs', maxEntries: 5000 });
configureLogline({ plugins: [storage] });
const errors = await storage.getLogs(50, { level: 'ERROR' });
// Call only when persistence is no longer needed.
storage.dispose();
```

With automatic initialization, later factory calls reuse the instance and warn once that manual options are ignored. Configuration updates do not remove that automatic instance.

Database name precedence is explicit databaseName, injected Vite base, runtime BASE_URL, then logline. Root deployments use logline; subpaths use `logline:<normalized base>`. Unresolved dynamic placeholders are ignored. Explicit naming overrides deployment isolation.

Use the instance's getLogs for an explicitly named database. The standalone getLogs uses automatic naming and cannot select an explicit database. Confirm actual names in browser developer tools under Application → IndexedDB; page routes do not determine Vite base.

The plugin independently persists global error and unhandledrejection events with source prefixes, without repeating console output. Errors retain name, message, and stack. It does not persist ordinary console calls after startup takeover.

## Optional startup capture

HTML Interop is an opt-in feature of final browser applications. Enable it when failures before the main entry or IndexedDB installation must be captured; do not enable it merely because the project uses Vite or Vue.

```ts
loglineVitePlugin({
  htmlInterop: { inline: true, position: 'head-prepend', esbuildTarget: 'es2016' },
  indexedDB: true,
});
```

Importing the main Logline entry alone does not proxy console. Explicit HTML Interop injects early capture of console, error, and unhandledrejection. IndexedDB creation restores console, removes startup listeners, transfers buffered records, and clears the startup globals. Application mount, window load, normal logging, and configuration calls do not stop capture early.

The startup buffer retains up to 1000 records. It does not deduplicate before capacity. At capacity, duplicate errors are compared using complete arguments and exact stack locations, keeping the latest match; non-errors are evicted first. The read-only `globalThis.__LOGLINE_HTML_INTEROP_PEEK__` entry returns a copy without clearing capture.

For a deliberate read-only observer mode, HTML Interop may run without IndexedDB; capture then lasts for the page lifecycle with the bounded buffer. Otherwise pair startup capture with persistence. Inline scripts must avoid raw HTML-forbidden control characters.

## Click logging and exports

`createClickLogPlugin` from `logline/plugin/click-log` records element selectors and text on click/touch events. It uses limited masking heuristics and should be installed once per page; it currently has no disposal API.

| Import path                | Purpose                                |
| -------------------------- | -------------------------------------- |
| `logline`                  | Log functions and global configuration |
| `logline/auto-import`      | Auto-import configuration              |
| `logline/vite-plugin`      | Vite integration                       |
| `logline/html-interop`     | Explicit startup capture               |
| `logline/plugin/indexeddb` | Persistence and queries                |
| `logline/plugin/click-log` | Click/touch logging                    |

Read the bundled README and docs for complete options and migration details.
