# Server ingestion

## Purpose

Define the authenticated batch upload protocol, durability and overload behavior. See the [ingestion API](../../../docs/server-ingestion.md).

## Requirements

### Requirement: Authorize and validate uploads

`POST /api/v1/logs` SHALL require a write-only project key for the envelope's server-issued `projectId`. Its UTF-8 JSON envelope SHALL contain only `projectId` and a nonempty `events` array. The server SHALL enforce request, batch and event bounds and validate event IDs, severity, timestamp, message and optional structured data. Malformed or duplicate IDs that prevent identifying batch entries SHALL invalidate the envelope.

#### Scenario: Reject one invalid event

- **WHEN** a batch has distinct valid IDs and an event has invalid content or supplies the reserved top-level `ingestKeyId`
- **THEN** the response marks that ID permanently rejected and valid siblings remain eligible for commit.

#### Scenario: Prevent cross-project writes

- **WHEN** a valid project key targets another project UUID
- **THEN** the server returns 403.

### Requirement: Acknowledge durable idempotent writes

The server SHALL acknowledge accepted IDs only after PostgreSQL commit. Event identity SHALL be `(projectId, id)`, and the first commit SHALL record the project key ID as server-owned provenance. Tags SHALL be indexed and discovered per project without requiring DDL for new tag keys.

#### Scenario: Replay a retained ID

- **WHEN** a valid request replays a committed event ID in the same project
- **THEN** the server acknowledges the existing event without modifying its payload or key attribution and without charging new storage quota.

### Requirement: Bound admission and per-project quotas

Replicas SHALL share a primary and enforce per-project fixed-minute limits on new events and serialized event bytes. The upload path SHALL use bounded concurrency, including body reads, and return retry guidance for saturation or primary unavailability.

#### Scenario: Exhaust a project quota

- **WHEN** the remaining quota cannot fit all new valid events in the batch
- **THEN** the server returns 429 with accepted duplicates, retryable new IDs, permanent rejections, and retry timing.

### Requirement: Apply browser upload origin policy

The upload route SHALL support browser preflight for POST with Authorization and Content-Type. An empty `LOGLINE_INGEST_ORIGINS` SHALL allow browser origins by default. A configured list SHALL match exact origins. Requests without an Origin header SHALL continue through normal upload authorization.

#### Scenario: Browser origin outside the allowlist

- **WHEN** a browser supplies an origin outside a configured allowlist
- **THEN** the upload origin policy denies the request.
