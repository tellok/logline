# v2 migration and release policy

[简体中文](./migration-v2.zh-CN.md) | [English README](../README.md) | [中文 README](../README.zh-CN.md)

v2 provides a standalone structured frontend logger under the MIT license.

## Branches and channels

The default branch maintains v2 beta. Stable v1 is preserved in the [v1 branch](https://github.com/tellok/logline/tree/v1). Install `logline@beta` for v2; ordinary installs continue using the newest published v1 subversion.

## Migrating from v1

v2 is a rewrite of the public Logline API. Replace v1 constructor and storage-protocol usage with named logging functions and plugins; v2 does not provide WebSQL or localStorage protocols.

- Import `TRACE`, `DEBUG`, `LOG`, `WARN`, and `ERROR` from `logline`.
- Configure logging with `configureLogline`; read or reset configuration with `getLoglineConfig` and `resetLoglineConfig`.
- Use `loglineVitePlugin` from `logline/vite-plugin` for source prefixes and build-level filtering.
- Use `createLoglineAutoImport` from `logline/auto-import` for optional auto-import integration.
- Configure persistence with `createIndexedDBLoggingPlugin` from `logline/plugin/indexeddb`. Existing databases are not imported automatically.

See the [README](../README.md) for complete examples and the [IndexedDB reference](./indexeddb.md) for persistence options.

## Release policy

Changesets prepares a reviewed version PR. Only its verified merge can publish with beta, keeping latest on the newest stable v1. See [release flow](./release-flow.md).
