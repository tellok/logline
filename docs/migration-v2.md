# v2 migration and release policy

[简体中文](./migration-v2.zh-CN.md) | [English README](../README.md) | [中文 README](../README.zh-CN.md)

v2 provides a standalone structured frontend logger under the MIT license.

## Branches and npm channels

| Channel         | Git branch | npm tag                   | API                                  |
| --------------- | ---------- | ------------------------- | ------------------------------------ |
| Stable v1       | `master`   | `latest`                  | Constructor and storage protocol API |
| Experimental v2 | `v2`       | `next`, after publication | Named TypeScript exports and plugins |

The `v2` branch preserves v1 history but replaces its legacy build, bundled artifacts, examples, and tests with the independent v2 implementation. No v2 code is merged into `master`. The initial version is `2.0.0-alpha.0`; no stable v2 release is implied.

## Migrating from std-logging

| Previous name                                   | v2 name                                   |
| ----------------------------------------------- | ----------------------------------------- |
| `std-logging` or its scoped package name        | `logline`                                 |
| `configureStdLogging`                           | `configureLogline`                        |
| `getStdLoggingConfig` / `resetStdLoggingConfig` | `getLoglineConfig` / `resetLoglineConfig` |
| `stdLoggingVitePlugin`                          | `loglineVitePlugin`                       |
| `createStdLoggingAutoImport`                    | `createLoglineAutoImport`                 |
| `stdLoggingAutoImportResolvers`                 | `loglineAutoImportResolvers`              |
| `StdLoggingConfig` / `StdLoggingPlugin`         | `LoglineConfig` / `LoglinePlugin`         |
| `STD_LOGGING_MODULE_ID`                         | `LOGLINE_MODULE_ID`                       |

The `plugin/indexeddb`, `plugin/click-log`, `auto-import`, `html-interop`, and `vite-plugin` subpaths remain available under `logline`. `createIndexedDBLoggingPlugin`, `createClickLogPlugin`, and the five logging functions retain their names.

Default database names now start with `logline`, and HTML Interop globals use `__LOGLINE_*`. Historical `std-logging` databases are not imported automatically. Explicitly configure the prior `databaseName` if access to that database is intentional. Migrating from v1 requires adapting the constructor API and storage usage; WebSQL and localStorage protocols are not provided by v2.

## Publish an experiment

1. Check out `v2` and select an unused prerelease version.
2. Run `pnpm install --frozen-lockfile`, type checking, linting, tests, formatting checks, and `pnpm pack`.
3. Authenticate with npm and publish locally from `v2` using `pnpm run release:next`, which explicitly sets `--publish-branch v2 --tag next`.
4. Verify `npm view logline dist-tags --json`: `next` must point to the experiment and `latest` must still point to v1.

Manual workflow dispatch requires a workflow on the default branch, so this isolated experiment uses local publishing and branch-only verification CI. See [GitHub workflow dispatch requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

Do not publish experiments with `--tag latest` or change the default branch. A stable v2 launch requires a separate decision.
