# Operating Logline Server

## Purpose

Define supported deployment and operational boundaries. See the [operations guide](../../../docs/server-operations.md).

## Requirements

### Requirement: Run against one shared PostgreSQL primary

Server replicas SHALL complete serialized database initialization before listening and use one PostgreSQL primary with matching quota and retention settings. Each replica SHALL isolate upload admission and pooling from Explorer, export, and MCP work. The local Compose deployment SHALL expose the API on loopback and keep PostgreSQL on the private network.

#### Scenario: Run multiple replicas

- **WHEN** a replica acknowledges an upload
- **THEN** an authorized new primary-backed query can find the committed event through another replica without a sticky session.

### Requirement: Expose health, metrics and bounded shutdown

The server SHALL provide liveness at `/health`, database readiness at `/ready`, and administrator-authenticated per-process metrics at `/metrics`. Shutdown SHALL stop admission, drain HTTP requests with a 15-second connection deadline, and close database pools.

#### Scenario: The primary becomes unavailable

- **WHEN** database connectivity fails while the process remains alive
- **THEN** liveness remains available and database readiness fails.

### Requirement: Expire stored events by receipt time

Retention SHALL use time received by the server and delete records in bounded sweeps. Deduplication SHALL apply while the original row remains stored.

#### Scenario: Replay after retention

- **WHEN** a previously committed ID is submitted after its retained row is physically removed
- **THEN** it may be accepted as a new event.
