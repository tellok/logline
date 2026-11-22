---
logline: minor
---

Add Sentry-style event tags end to end: global and per-call flat string tags on log records, tags persisted with IndexedDB records and reporting snapshots, a server `tags` column with a GIN index covering every pair, tag-aware filtering and aggregation in the Logs Explorer, and automatic per-project tag key discovery with retention-based expiry.
