# Beta release flow

English | [简体中文](./release-flow.zh-CN.md)

The default branch is discovered from GitHub (currently master). The previous default-branch snapshot is preserved as v1. Changesets CLI 2.29.7 versions the public `logline` and `logline-server-reporter` npm packages **independently**: a Changeset names the packages it changes, and internal dependency propagation advances a dependent package by patch. The private `logline-server` keeps its own `package.json` version and ships as a container image, not an npm package. The first release is 2.0.0-beta.0; subsequent changes remain in beta prerelease mode until a separate stable-v2 decision.

## Events and version decisions

1. A feature PR adds an English Changeset and a Chinese summary in translations.json. Native PR checks validate the latest source merged into the latest target.
2. A default-branch push detects unconsumed Changesets before dependency installation. README, hidden files, metadata, and already-consumed prerelease IDs are excluded. Malformed candidates fail during CLI versioning.
3. If changes exist, the lightweight preparation workflow runs the pinned CLI, generates each changed package's bilingual changelog chapters, prerelease bookkeeping, and a per-package version plan, then creates or updates the `release/version-update` branch and its managed version PR. It does not build, publish, or upload product files.
4. The managed version PR shows the proposed versions, base source SHA, packages, channel, and user-facing changes. It is not automatically merged. This initial rollout is merged under the user's explicit authorization; subsequent merges remain maintainer decisions.
5. Only a merged, managed version PR may authorize delivery. Ordinary pushes, feature PRs, tags, and manual runs without valid version-PR provenance cannot publish.

Use merge commits for version PRs. Squash/rebase version merges are rejected by the current contract. The actual merge must have the recorded base and version-PR head as its two parents. The release gate checks repository, actual default branch, managed branch, PR marker and label, allowed version-only files, package versions, beta channel, and Changeset digests. It reruns version preparation in an isolated checkout and compares every version file byte-for-byte before product building starts.

Prerelease Changesets remain in the directory while their IDs are tracked in pre.json. Pending detection excludes those consumed IDs; retained historical summaries therefore do not cause empty version PRs.

## Version-PR write identity

Version preparation uses the reusable `changesets-version-pr` component from `tellok/actions`, pinned to the default-branch commit `9df224593aad286a012adc6760fa7de7cb175e22`. The component detects pending Changesets, invokes the project's `scripts/version-maintain.mjs` as its version command, and creates or updates one managed PR on the fixed `release/version-update` branch.

Version-branch push and PR creation use a dedicated fine-grained PAT in `secrets.VERSION_PR_TOKEN`, never the job `GITHUB_TOKEN`. The expected PR author is the PAT user, read from `vars.VERSION_PR_AUTHOR` and passed as the component's `managed-author`. Git commit author/committer remains an automation identity; the PR author is the authenticated PAT user. `actions/checkout` runs with `persist-credentials: false`, and the version command runs under the component's stripped environment without release secrets.

## Latest merged-result checks

Source updates use native pull_request events and GitHub's test merge commit. Target pushes enumerate all affected open PRs, including non-default targets. Same-repository collaborators and authorized automation use immutable synthetic refs (`ci/merged/pr-…`) to the current native merge commit, so CI configuration, scripts, installation, tests, and build all come from the same merged tree. Neither source nor target refs are changed. Head/base/merge parents are checked before and after verification; stale results fail. Per-PR concurrency and API cancellation stop older checks.

Each workflow checks out its own event revision and reads that checkout's `.node-version` through the standard `setup-node` `node-version-file` input. The refresh controller uses its pushed or manually selected revision for both scripts and configuration; it does not substitute default-branch code. The completion handler uses the `workflow_run` event's revision, which GitHub defines on the default branch.

Native `pull_request` events directly run CI for source updates; they do not trigger the refresh controller. Automatic refresh runs only on branch pushes and selects open PRs whose **target** is the pushed branch. A source-only branch push schedules no additional PR CI, unless that branch is itself the target of another open PR. Manual refresh can explicitly select a PR.

External fork PRs use GitHub's native execution approval policy. The target-refresh controller does not dispatch fork code with privileged repository context: it records an action-required merged-result check instead. A maintainer must approve and run a fresh native merged-result validation before merging. Automatic target-only refresh for external forks is deliberately not claimed as verified; it requires the native approval boundary and a current merge identity. Do not bypass this with privileged workflow dispatch. Merge conflicts or stale native merge refs fail instead of silently checking only source code.

Synthetic check refs are removed only after all their CI consumers complete, including failure or cancellation. The trusted completion handler checks repository, exact ref pattern, SHA, current ref identity, and active consumers. It never checks out upstream code. If cleanup fails, its workflow fails visibly; retry that same cleanup run or remove only the verified stale ref. There are no temporary CI file artifacts to clean.

## Quality and one-build delivery

The verification command runs type checks, lint, release-contract tests, product tests, formatting, one product build, and package-entry checks. A job-local structured Vitest report must show nonzero tests, every test passed, and zero skipped tests. Reports are not uploaded; counts appear in logs and Job Summary.

A separate CI matrix tests the packed package against the latest stable release within each supported Vite major (5, 6, 7, and 8). Each consumer installs its own Vite and checks strict public types, development transforms and dependency optimization, production stripping, source attribution, base injection, IndexedDB initialization, HTML startup capture, and sourcemaps. Run `pnpm run build && pnpm run test:vite` locally, or append `-- 5` to select one major. The repository toolchain stays on Vite 6 so Vitest can run independently of consumer Vite versions.

PR builds stay local and never become release inputs. After source eligibility succeeds, the release job checks out that exact merge source, repeats quality verification, builds once, and packs each changed package with scripts disabled. Each package's exact tarball is published to npm with `beta`, then its own immutable Git tag and GitHub prerelease are created from that package's own changelog chapter via the reusable `github-release` component. It does not rebuild for another consumer or upload a CI transfer copy.

Release notes come from exactly one chapter for the actual version in each package's changelog. Missing or duplicate chapters fail. No previous chapters or pending changes are included. Existing npm versions, tags, and release assets are reused only if their immutable identities/digests match; conflicts are rejected, never overwritten.

## Storage and permissions

| Stage                       | Access                                                     | Product files                                         |
| --------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| Native/merged-result checks | Read repository and PR metadata                            | Job-local build and report; no upload                 |
| Version preparation         | PAT contents/PR write; detect is read-only                 | Version source files only; no product build           |
| Target refresh              | Contents/actions/checks write; event-revision control code | Synthetic refs only; no PR build in controller        |
| Release eligibility         | Contents/PR read                                           | Isolated version replay; no product build             |
| Verified beta delivery      | Contents write, PR read, id-token write                    | Local validated tarballs; durable npm/GitHub delivery |
| Ref cleanup                 | Contents write, actions read; workflow event revision      | Exact completed synthetic refs only                   |

Configure npm trusted publishing for **each** package with tellok/logline, release.yml, no environment, and direct npm publish. The runner uses Node.js 24 and npm 11.15.0. Publishing prefers trusted publishing (OIDC); an optional granular classic token in `secrets.NPM_TOKEN` is used only as a fallback when a package has no trusted publisher configured (for example, a brand-new package's first publish). Once trusted publishing is in place the token is never used, so it can be removed after the first publish instead of rotating it on the 90-day expiry. The repository URL must match GitHub exactly. After npm delivery, separate release jobs deploy the documentation site and publish the version-tagged server image for Linux amd64 and arm64. The server image is tagged with the private `logline-server` package's own version and published to its own GitHub prerelease with the OCI archive, deployment bundle, and checksums. The server-image job needs registry package-write and release contents-write permissions. See the [operations guide](./server-operations.md) for installation.

## Beta and v1 installation

Publishing always passes --tag beta. For `logline`, before and after publication, `latest` must equal the greatest published stable v1 minor/patch version, not a fixed 1.0.0. The flow never writes latest; stable-v1 maintenance owns that channel. Install logline@beta for v2, logline@1 to constrain the major line, or logline for the latest stable v1. Install `logline-server-reporter@beta` for the matching self-hosted uploader.

## Concurrency and recovery

Version preparation is serialized and older preparation runs are cancelled. The reusable component re-checks the default source and managed branch before and after preparing, and uses an exact lease when replacing the managed version branch. Managed PR body regions are replaced while outside notes are retained; unknown writes are confirmed by rereading PRs.

Release delivery is serialized without cancellation. Each package is delivered independently: an unchanged package is not re-tagged, re-released, or re-published. Manual recovery accepts the exact merged version-PR SHA and repeats all provenance and quality checks; it cannot authorize an arbitrary source or version. If npm publication succeeded but GitHub assets failed, rerunning the original source checks the npm digest and fills only missing matching assets. Job-local files are rebuilt from that original verified source after runner loss. GitHub prereleases are never marked latest.

## Validation evidence

Local tests cover beta-only versions, newest-v1 selection, precise changelog extraction, candidate/consumed-file detection, and independent per-package versioning. Real rollout checks exercise a feature PR, automatic lightweight version PR preparation, merged-result verification, source replay, OIDC npm publication, GitHub delivery, and default-install preservation. Record actual run links and outcomes when completed; these documents do not claim unexecuted external-fork approval or cancellation scenarios have passed.

The design follows the [version-PR release Skill](https://github.com/tellok/dotai/tree/main/skills/design-pr-versionization), [Changesets prerelease guidance](https://changesets.dev/guide/prereleases), and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). Reusable components are pinned to `tellok/actions` default-branch commit `9df224593aad286a012adc6760fa7de7cb175e22`.

## Online documentation

The bilingual VitePress site is hosted at https://tellok.github.io/logline/ (English) and https://tellok.github.io/logline/zh/ (Simplified Chinese). The Pages source is GitHub Actions. PR checks build both languages and reject broken internal links.

After verified npm and GitHub release delivery succeeds, the documentation job checks out the same verified release SHA, builds the site once, and deploys through the github-pages environment. Ordinary pushes and version preparation do not deploy. The site embeds the actual package version and source SHA in release.json. Repeating the original release restores documentation from that original source; it never substitutes the latest branch.

A single Pages artifact is required by the deploy-pages consumer. The job deletes that exact artifact after the deployment attempt; a one-day expiry limits retention if runner loss prevents cleanup. Deleting this transfer artifact does not remove the deployed site. Documentation build or deployment failure fails the release workflow; a successful npm upload remains published and is verified on recovery.

For local work, use pnpm docs:dev, pnpm docs:build, and pnpm docs:preview. README and Markdown guides remain the source of truth; generated staging and output are ignored and excluded from npm packaging.

The private workspace root owns tooling; publishable manifests and bilingual changelogs live under `packages/logline` and `packages/logline-server-reporter`. Version preparation updates only release metadata. Each Changeset lists one target per line; Chinese summaries under `translations.json` appear in the targeted packages' changelogs. A package advanced solely for dependency synchronization receives a synchronization note. Package verification stages public documentation from root sources before delivery. See the [workspace guide](./workspace.md).
