# Beta release flow

English | [简体中文](./release-flow.zh-CN.md)

The default branch is discovered from GitHub (currently master). The previous default-branch snapshot is preserved as v1. The package is logline, and Changesets CLI is pinned to 2.29.7. The first release is 2.0.0-beta.0; subsequent changes remain in beta prerelease mode until a separate stable-v2 decision.

## Events and version decisions

1. A feature PR adds an English Changeset and a Chinese summary in translations.json. Native PR checks validate the latest source merged into the latest target.
2. A default-branch push detects unconsumed Changesets before dependency installation. README, hidden files, metadata, and already-consumed prerelease IDs are excluded. Malformed candidates fail during CLI versioning.
3. If changes exist, the lightweight preparation workflow consumes them using the pinned CLI, generates package version, bilingual changelogs, prerelease bookkeeping, and public provenance, then creates or updates codex/version-packages. It does not build, publish, or upload product files.
4. The managed version PR shows the proposed version, base source SHA, package, channel, and user-facing changes. It is not automatically merged. This initial rollout is merged under the user's explicit authorization; subsequent merges remain maintainer decisions.
5. Only a merged, managed version PR may authorize delivery. Ordinary pushes, feature PRs, tags, and manual runs without valid version-PR provenance cannot publish.

Use merge commits for version PRs. Squash/rebase version merges are rejected by the current contract. The actual merge must have the recorded base and version-PR head as its two parents. The release gate checks repository, actual default branch, managed branch, PR marker and label, allowed version-only files, package version, beta channel, and Changeset digests. It reruns version preparation in an isolated checkout and compares every version file byte-for-byte before product building starts.

Prerelease Changesets remain in the directory while their IDs are tracked in pre.json. Pending detection excludes those consumed IDs; retained historical summaries therefore do not cause empty version PRs.

## Latest merged-result checks

Source updates use native pull_request events and GitHub's test merge commit. Target pushes enumerate all affected open PRs, including non-default targets. Same-repository collaborators and authorized automation use immutable synthetic refs to the current native merge commit, so CI configuration, scripts, installation, tests, and build all come from the same merged tree. Neither source nor target refs are changed. Head/base/merge parents are checked before and after verification; stale results fail. Per-PR concurrency and API cancellation stop older checks.

External fork PRs use GitHub's native execution approval policy. The target-refresh controller does not dispatch fork code with privileged repository context: it records an action-required merged-result check instead. A maintainer must approve and run a fresh native merged-result validation before merging. Automatic target-only refresh for external forks is deliberately not claimed as verified; it requires the native approval boundary and a current merge identity. Do not bypass this with privileged workflow dispatch. Merge conflicts or stale native merge refs fail instead of silently checking only source code.

Synthetic check refs are removed only after all their CI consumers complete, including failure or cancellation. The trusted completion handler checks repository, exact ref pattern, SHA, current ref identity, and active consumers. It never checks out upstream code. If cleanup fails, its workflow fails visibly; retry that same cleanup run or remove only the verified stale ref. There are no temporary CI file artifacts to clean.

## Quality and one-build delivery

The verification command runs type checks, lint, release-contract tests, product tests, formatting, one product build, and package-entry checks. A job-local structured Vitest report must show nonzero tests, every test passed, and zero skipped tests. Reports are not uploaded; counts appear in logs and Job Summary.

PR builds stay local and never become release inputs. After source eligibility succeeds, the release job checks out that exact merge source, repeats quality verification, builds once, and packs the validated dist with scripts disabled. It publishes this exact tarball to npm with beta and uploads the same tarball and its digest/source manifest as durable GitHub prerelease assets. It does not rebuild for another consumer or upload a CI transfer copy.

Release notes come from exactly one chapter for the actual version in each changelog. Missing or duplicate chapters fail. No previous chapters or pending changes are included. Existing npm versions, tags, and release assets are reused only if their immutable identities/digests match; conflicts are rejected, never overwritten.

## Storage and permissions

| Stage                       | Access                                                      | Product files                                          |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| Native/merged-result checks | Read repository and PR metadata                             | Job-local build and report; no upload                  |
| Version preparation         | Contents/PR/actions write                                   | Version source files only; no product build            |
| Target refresh              | Contents/actions/checks write; trusted default control code | Synthetic refs only; no source execution in controller |
| Release eligibility         | Contents/PR read                                            | Isolated version replay; no product build              |
| Verified beta delivery      | Contents write, PR read, id-token write                     | Local validated tarball; durable npm/GitHub delivery   |
| Ref cleanup                 | Contents write, actions read; trusted default code          | Exact completed synthetic refs only                    |

npm trusted publishing is configured for tellok/logline, release.yml, no environment, and direct npm publish. The runner uses Node.js 24 and npm 11.15.0. No persistent npm publishing token is stored. The repository URL must match GitHub exactly. No Docker images, documentation hosting, temporary CI transfer artifacts, or test-report uploads are part of this flow.

## Beta and v1 installation

Publishing always passes --tag beta. Before and after publication, latest must equal the greatest published stable v1 minor/patch version, not a fixed 1.0.0. The flow never writes latest; stable-v1 maintenance owns that channel. Install logline@beta for v2, logline@1 to constrain the major line, or logline for the latest stable v1.

## Concurrency and recovery

Version preparation is serialized and older preparation runs are cancelled. It checks the current default source before and after preparing and uses an exact lease when replacing the managed version branch. Managed PR body regions are replaced while outside notes are retained; unknown writes are confirmed by rereading PRs.

Release delivery is serialized without cancellation. Manual recovery accepts the exact merged version-PR SHA and repeats all provenance and quality checks; it cannot authorize an arbitrary source or version. If npm publication succeeded but GitHub assets failed, rerunning the original source checks the npm digest and fills only missing matching assets. Job-local files are rebuilt from that original verified source after runner loss. GitHub prereleases are never marked latest.

## Validation evidence

Local tests cover beta-only versions, newest-v1 selection, precise changelog extraction, and candidate/consumed-file detection. Real rollout checks exercise a feature PR, automatic lightweight version PR preparation, merged-result verification, source replay, OIDC npm publication, GitHub delivery, and default-install preservation. Record actual run links and outcomes when completed; these documents do not claim unexecuted external-fork approval or cancellation scenarios have passed.

The design follows the [version-PR release Skill](https://github.com/tellok/dotai/tree/main/skills/design-pr-versionization), [Changesets prerelease guidance](https://changesets.dev/guide/prereleases), and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

After npm accepts an upload, delivery waits up to ten minutes for registry visibility, retrying only version-not-found responses. Other registry errors and integrity mismatches fail immediately.
