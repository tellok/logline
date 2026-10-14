# v2 migration and release policy

[简体中文](./migration-v2.zh-CN.md) | [English README](../README.md) | [中文 README](../README.zh-CN.md)

v2 provides a standalone structured frontend logger under the MIT license.

## Branches and channels

The default branch maintains v2 beta. Stable v1 is preserved in the [v1 branch](https://github.com/tellok/logline/tree/v1). Install `logline@beta` for v2; ordinary installs continue using the newest published v1 subversion.

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

## Release policy

Changesets prepares a reviewed version PR. Only its verified merge can publish with beta, keeping latest on the newest stable v1. See [release flow](./release-flow.md).
