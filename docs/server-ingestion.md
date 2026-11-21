# Ingestion HTTP API

[简体中文](./server-ingestion.zh-CN.md)

Use a service user's `logs:write` PAT with write access to the target project. Never put a deployment administrator token in an uploader or a long-lived PAT in a public browser bundle. Use TLS at the ingress and protect the database connection. The server does not provide browser sign-in.

## Upload a batch

`POST /api/v1/logs`, `Content-Type: application/json`, `Authorization: Bearer <PAT>`:

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "service": "example-api",
  "events": [
    {
      "id": "example-request-01",
      "level": "WARN",
      "timestamp": 1760000000000,
      "message": "Example request exceeded its time budget",
      "fields": { "durationMs": 125 },
      "context": { "environment": "test", "traceId": "example-trace" }
    }
  ]
}
```

Use the **server-issued project UUID**, not its slug. Service and event IDs are nonblank strings of at most 128 UTF-8 bytes. A batch needs at least one event and distinct IDs. Levels: `TRACE`, `DEBUG`, `LOG`, `WARN`, `ERROR`. Timestamps are integer Unix epoch milliseconds in `[0,253402300799999]`. Message must be a string. `fields` and `context` are optional JSON objects. If present, `context.environment`, `release`, `traceId`, `sessionId`, `userId` must be strings ≤1,024 bytes. Additional attributes on the event are preserved. Keep an entire event ≤65,536 UTF-8 bytes after JSON serialization, nesting ≤24, and object keys ≤1,024 bytes. Non-finite numbers, NUL and ill-formed Unicode are rejected. Input is uncompressed UTF-8 JSON.

A `200` response partitions every input ID (ordering is not a contract):

```json
{ "acceptedEventIds": ["example-request-01"], "retryableEventIds": [], "rejectedEventIds": [] }
```

- **Accepted** means committed to PostgreSQL and immediately visible to authorized new queries on the primary. A successful replay acknowledges the existing `(projectId,id)` without changing it or charging fresh storage quota, even if its contents differ. Use stable, unique IDs and retry with exactly the original data.
- An individually identifiable invalid event is permanently **rejected**; valid siblings can still commit. Missing/repeated IDs invalidate the entire envelope (`400`); excessively large bodies/batches return `413`. `401` = absent/invalid PAT, `403` = insufficient scope or project grant. Non-acknowledgment errors use `{"error":{"code":"…","message":"…"}}`.
- `429` means the project's remaining fixed-minute event or byte quota cannot admit **all new valid events**. The body partitions accepted duplicates, retryable new IDs and permanent rejections and adds `retryAfterMs`; `Retry-After` is rounded up to seconds. Keep batches smaller than a whole minute's quota. `503` with `Retry-After` means retry the unacknowledged batch with backoff/jitter; this includes connection/statement failures, a busy replica/project or draining. A lost response or ambiguous commit may cause a replay, not a second stored row while the original remains retained.
- Upload commits directly. There is **no server flush endpoint**, RAM delivery queue, background indexer, or broker offset to wait for. A client's flush only drains its own reporting queue. Acknowledged data survives ingress pod loss; durability against database/node loss depends on PostgreSQL fsync, durable volumes, replication and backups. Do not use an ephemeral database or asynchronous read replicas for authorization/query visibility.

## Operating bounds

All replicas must use the same PostgreSQL primary and matching project quota/retention settings. Startup serializes schema creation in the DB before listening. The deployment account needs DDL privileges on its own database/schema. A project quota row is locked per batch: different projects can write concurrently; a single hot project serializes at that row. At most half a replica's upload slots (rounded up) may execute database work for one project. Upload reservations include body reads and have no application-side waiting queue. Query/export/MCP use a separate pool and concurrency budget. An ingress should additionally apply connection/request limits for unauthenticated traffic.

| Setting                                                 |           Default | Meaning                                                                                                          |
| ------------------------------------------------------- | ----------------: | ---------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                          |          required | PostgreSQL primary URL; PostgreSQL 16/17 (integration tests on 16; deployment on 17)                             |
| `LOGLINE_ADMIN_TOKEN`                                   |          required | Random deployment secret, at least 32 non-space printable ASCII bytes; no comma or `llpat_` prefix               |
| `HOST`, `PORT`                                          | `0.0.0.0`, `4318` | HTTP listener                                                                                                    |
| `MAX_BODY_BYTES`, `MAX_BATCH_EVENTS`                    |      1048576, 500 | Raw request bytes (also bounds admin/query bodies); upload events per batch                                      |
| `PROJECT_EVENTS_PER_MINUTE`, `PROJECT_BYTES_PER_MINUTE` |   60000, 67108864 | New events and their serialized UTF-8 bytes per project per DB-clock minute; not wire bytes or on-disk size      |
| `INGEST_CONCURRENCY`, `QUERY_CONCURRENCY`               |             12, 4 | Per-replica admission and pool limits; reserve up to two additional connections per replica for health/retention |
| `RETENTION_DAYS`                                        |                30 | Keep by **receipt** time, irrespective of producer time                                                          |
| `LOGLINE_MCP_ENABLED`                                   |            `true` | Set `false` to disable `/mcp`                                                                                    |

Body deadline 10 s; DB pool checkout 3 s; default statement timeout 5 s. Size PostgreSQL `max_connections`, memory, disk, and autovacuum for all replicas plus deployment overlap. Retention deletes up to 5,000 expired rows per sweep per replica, normally once per minute and once per second while a full slice is found. This is eventual housekeeping, not a precise TTL or a disk capacity limit. Monitor growth against cleanup throughput; a replay after physical deletion can insert again. Hard caps/partitioned archival are not implemented.

`GET /health` tests liveness without requiring the DB; `GET /ready` checks DB connectivity. `GET /metrics` requires the administrator bearer token and emits per-process Prometheus text counters for inserted events/bytes, accepted IDs (including replays), rejected/retryable IDs, overloads, retention and storage errors; in-flight gauges and request-duration histograms distinguish admitted uploads from queries. Pre-body overloads have no event count. Backlog is zero because no asynchronous delivery buffer exists. Scrape each replica separately and sum rates, not cumulative counters across restarts. SIGTERM/SIGINT stops admission, drains active HTTP requests (force-closes connections at 15 s), then closes the pools. Configure a longer termination grace period. No sticky sessions are required.
