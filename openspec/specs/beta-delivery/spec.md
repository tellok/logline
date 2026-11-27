# Beta release delivery

## Purpose

Define workspace verification, release provenance, versioning, and delivery for Logline v2. See the [workspace guide](../../../docs/workspace.md) and [release-flow contract](../../../docs/release-flow.md).

## Requirements

### Requirement: Prepare package versions without product delivery

The default branch SHALL use pending Changesets to prepare a managed version PR with independent package versions and matching bilingual changelog chapters. Consumed prerelease entries SHALL be excluded from pending detection. Version preparation SHALL complete without building or publishing the product.

#### Scenario: Change one public package

- **WHEN** a feature Changeset changes one public package
- **THEN** version preparation advances that package and any package advanced by internal dependency propagation.

### Requirement: Verify the current merged result

PR checks SHALL validate the current synthetic merged tree rather than the source branch in isolation. Target refresh SHALL verify merge and source identity, with external fork code using native approval boundaries. Product verification SHALL include types, lint, nonempty passing test suites, formatting, and package checks. CI SHALL exercise packed Vite consumers across majors 5–8.

#### Scenario: Detect a stale or conflicted merge

- **WHEN** the required merge identity is stale or the source and target conflict
- **THEN** verification cannot succeed on source code alone.

### Requirement: Gate and recover beta delivery

Only a verified merge of the managed version PR SHALL authorize new beta delivery. Before building, the release gate SHALL check merge provenance and replay versioning against the recorded source. Delivery SHALL build once per run, publish the validated tarballs with the beta tag, and preserve `logline@latest` as the newest stable v1 release.

#### Scenario: Resume a partially completed release

- **WHEN** delivery is retried for the same verified source and some immutable artifacts already exist
- **THEN** matching artifacts are reused and missing deliverables are completed.
- **AND** conflicts in immutable identity or digest fail delivery.

### Requirement: Deliver documentation and server images

Verified beta delivery SHALL build and deploy the bilingual documentation from the verified release source. The server container SHALL use the server's own version and ship an OCI index for Linux amd64 and arm64 with an offline archive, deployment bundle, and checksums.

#### Scenario: Prepare a version PR or push an ordinary change

- **WHEN** no verified merged version release authorizes delivery
- **THEN** the release workflow does not deploy the documentation or publish a server image.
