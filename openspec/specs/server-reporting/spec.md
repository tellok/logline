# Logline Server reporter

## Purpose

Define the optional DSN-based adapter between Logline reporting and self-hosted ingestion. See the [reporter README](../../../packages/logline-server-reporter/README.md).

## Requirements

### Requirement: Resolve a project DSN to an authenticated upload

The reporter SHALL expose a transport factory and a reporting-plugin factory. It SHALL extract the project UUID and project key from `https://<key>@<host>[/prefix]/<project-uuid>`, allow HTTP only on loopback, and reject passwords, query strings, and fragments.

#### Scenario: Upload via a reverse proxy prefix

- **WHEN** the reporter sends a batch using a valid DSN with a path prefix
- **THEN** it posts `{projectId, events}` to `/api/v1/logs` under that prefix and sends the project key only in the bearer header.
- **AND** the request omits ambient cookies and does not follow redirects.

### Requirement: Preserve ingestion acknowledgement semantics

The adapter SHALL validate acknowledgement partitions and preserve valid partial quota acknowledgements. Network failures and HTTP 408, 425, 429, and 5xx SHALL be eligible for bounded retries. Other HTTP failures SHALL reject the batch.

#### Scenario: Retry only the quota-deferred events

- **WHEN** a 429 body contains a valid partition and retry delay
- **THEN** accepted replays and permanently rejected IDs leave the queue and only the retryable IDs remain eligible for resend.
