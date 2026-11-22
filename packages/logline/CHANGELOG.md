# Changelog

## 2.0.0-beta.1

### Minor Changes

- 2928564: Add Sentry-style event tags end to end: global and per-call flat string tags on log records with imperative `setTag`/`setTags`/`removeTag` management and `withScope` for path-local scoping, tags persisted with IndexedDB records and reporting snapshots, a server `tags` column with a GIN index covering every pair, tag-aware filtering and aggregation in the Logs Explorer, and automatic per-project tag key discovery with retention-based expiry.
- 5e70db0: Add opt-in asynchronous reporting, a project DSN uploader for self-hosted deployments, and the Logline ingestion, management, Logs Explorer, and MCP service.

### Patch Changes

- c90a147: Add bilingual online documentation deployed to GitHub Pages after verified beta releases.
- 5b0c8d2: Support Vite 5.2.8 and later with consumer-compatible esbuild types, and test packed-package consumers against the latest Vite 5, 6, 7, and 8 releases in CI.
- ce469c7: Fix Vite 8 development startup by using native Rolldown dependency transforms while preserving dependency attribution, deployment-specific IndexedDB names, and Vite 6/7 support.
- 4d43ee8: Move the library into a pnpm workspace with Nx task caching, pinned development toolchains, and workspace-aware packaging and release verification. Reserve the application workspace for the future logline-server.

## 2.0.0-beta.0

### Major Changes

- 7c6bfa6: Introduce the TypeScript v2 beta with structured logging, Vite integration, IndexedDB persistence, startup capture, and auto-import helpers.

[简体中文](./CHANGELOG.zh-CN.md)

Release entries are generated from Changesets during version preparation.
