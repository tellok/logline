# Workspace development

English | [简体中文](./workspace.zh-CN.md)

The workspace has two public beta packages: `packages/logline` (logger and optional reporting scheduler) and `packages/logserver-reporter` (HTTP uploader). `packages/logline-server` is the private PostgreSQL-backed service; see [self-hosting](./server-operations.md).

## Toolchain

The development baseline is Node.js **24.22.1 LTS** and **pnpm 11.25.0**. `.node-version` supports version managers such as fnm and mise. `packageManager` pins pnpm, and `pmOnFail: download` selects it automatically. `engines.runtime` selects Node.js for pnpm scripts and `pnpm exec`; it does not replace the interactive shell's Node.js. Corepack can also select the pinned pnpm when installed and enabled separately.

The root runtime selector uses pnpm’s `engines.runtime` field, which npm does not treat as a strict developer-version check. Engine checks are advisory, and pnpm selects its pinned tools using `download` rather than rejecting a version mismatch. The versions guide automatic selection without rejecting a different compatible host version. Keep `.node-version` and `engines.runtime` in sync when upgrading. CI reads `.node-version` and the root `packageManager` field.

For `test` and `verify`, set `TEST_DATABASE_URL` to a disposable PostgreSQL 16 database accessible to the test process. The reporter integration uses the built packages and a live server.

```sh
pnpm install --frozen-lockfile
pnpm run type-check
pnpm run lint
pnpm run test
pnpm run test:release
pnpm run build
pnpm run verify
pnpm run docs:build
pnpm run pack:logline
pnpm run pack:reporter
node scripts/check-package.mjs --reporter
```

`verify` requires every core, server, uploader and release-contract test to run without skips. It checks formatting, builds both libraries and stages public documentation. It then packs and opens both real tarballs in a temporary consumer, verifies the uploader's published peer version, and exercises ESM, CommonJS and strict TypeScript imports. Product tests run directly during this audit so a temporary report path is never lost to a cache hit. `pack:logline` runs `pnpm pack` inside the library and puts its tarball at the repository root. Its lifecycle type-checks and builds through Nx, then refreshes README, license, documentation, and consumer Skill copies from the root. Generated copies are ignored; edit their root sources.

## Layout and task caching

- `packages/logline`: library source, Vite configuration, strict TypeScript configuration, manifest, and bilingual changelogs.
- `scripts`, `docs`, `skills`, `.vitepress`: shared repository tooling and maintained public content.
- `tsconfig.base.json`, `eslint.config.ts`: shared TypeScript and lint configuration.
- `pnpm-workspace.yaml`, `pnpm-lock.yaml`: workspace settings and the single dependency lockfile.

Root build, type-check, lint, and test commands delegate to Nx targets inferred from package scripts. Builds wait for dependency builds and their own type checks; type checks wait for dependency type checks. Add workspace dependencies using `workspace:*` when another package is introduced. Future packages should declare their build outputs and use the same target names.

Nx stores local results in `.nx/cache`. Cache inputs include package sources and configuration, the root manifest, lockfile, workspace settings, shared TypeScript/ESLint settings, Nx configuration, actual Node.js/pnpm versions, and relevant build environment variables. Library builds restore `packages/logline/dist`; checks only replay their results. Generated build output and staged documentation are excluded from inputs. Publication, version preparation, packaging lifecycle hooks, documentation builds with checkout-specific metadata, and release verification remain uncached.

CI persists `.nx/cache` using GitHub Actions cache, scoped by machine identity, platform, workflow event, pull request, lockfile, toolchain, and Nx configuration. Nx database metadata is persisted alongside artifacts because the cache is machine-specific; independent runners build their own cache. Release jobs do not restore pull-request caches. Nx Cloud is disabled and no remote-cache credentials are required.

```sh
pnpm exec nx run logline:build
pnpm exec nx run logline:build # Reuses the result when inputs are unchanged.
pnpm exec nx run logline:build --skip-nx-cache
pnpm exec nx reset
pnpm run clean
```

`nx reset` clears Nx state and cached results. `clean` additionally removes library output and generated public content. To verify artifact restoration, remove `packages/logline/dist` after a successful build and run the same build again. Changes to relevant inputs trigger execution instead of replaying an old result.

## Releases

Changesets versions both public packages together; pnpm resolves the uploader’s workspace peer to the matching beta in its tarball. See the [release-flow contract](./release-flow.md) for the version and publication checks.
