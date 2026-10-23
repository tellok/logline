# Workspace development

English | [简体中文](./workspace.zh-CN.md)

The repository uses pnpm workspaces and Nx. `packages/logline` is the publishable v2 beta library; the root package is private. `apps/*` is reserved for future applications, including [logline-server (#53)](https://github.com/tellok/logline/issues/53). The server is not implemented yet.

## Toolchain

The development baseline is Node.js **24.22.1 LTS** and **pnpm 11.25.0**. `.node-version` supports version managers such as fnm and mise. `packageManager` pins pnpm, and `pmOnFail: download` selects it automatically. `engines.runtime` selects Node.js for pnpm scripts and `pnpm exec`; it does not replace the interactive shell's Node.js. Corepack can also select the pinned pnpm when installed and enabled separately.

The root runtime selector uses pnpm’s `engines.runtime` field, which npm does not treat as a strict developer-version check. Engine checks are advisory, and pnpm selects its pinned tools using `download` rather than rejecting a version mismatch. The versions guide automatic selection without rejecting a different compatible host version. Keep `.node-version` and `engines.runtime` in sync when upgrading. CI reads `.node-version` and the root `packageManager` field.

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
node scripts/check-package.mjs
```

`verify` audits actual product test counts and release-contract tests, checks formatting, builds the library, stages public documentation, and verifies exports. Product tests run directly during this audit so a temporary report path is never lost to a cache hit. `pack:logline` runs `pnpm pack` inside the library and puts its tarball at the repository root. Its lifecycle type-checks and builds through Nx, then refreshes README, license, documentation, and consumer Skill copies from the root. Generated copies are ignored; edit their root sources.

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

Changesets operates from the root and versions `packages/logline/package.json` and the library's changelogs. The private root has no release version. Version PR preparation only updates release metadata; it never builds or publishes the library. Existing beta safeguards remain in the [release-flow contract](./release-flow.md).
