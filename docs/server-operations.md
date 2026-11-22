# Operating Logline Server

[简体中文](./server-operations.zh-CN.md) · [Ingestion and limits](./server-ingestion.md) · [Administration](./server-admin.md) · [Explorer](./server-explorer.md) · [MCP](./server-mcp.md)

## Start locally

From the repository root, copy `.env.example` to `.env` with mode `0600`. Set **two independent secrets**: generate each with `openssl rand -hex 32`, paste one into `LOGLINE_ADMIN_TOKEN` and one into `POSTGRES_PASSWORD`. Do not reuse a PAT, commit the file, enable shell tracing or share `docker compose config` output. No usable default credential ships. The local database URL is constructed from this hex password; PostgreSQL initializes the password only when creating the volume, not on every boot.

```sh
docker compose up --build --detach --wait
curl --fail http://127.0.0.1:4318/ready
docker compose logs --tail=50 server
docker compose down  # retains the database volume
```

Compose runs one non-root API and one PostgreSQL primary on a private network; only HTTP is published, on loopback. Set `LOGLINE_PORT` to change the host port; set `LOGLINE_MCP_ENABLED=true` to enable authenticated `/mcp`. Use the [management API](./server-admin.md) to create a project and a named project ingestion key. Upload `{projectId, events}` with the project key as the bearer; use a user PAT with `logs:read` and a matching project grant for Explorer and MCP. Never inject the administrator credential into a client application or browser. For remote use, terminate TLS before HTTP, rate-limit connections at the edge and keep both the management API and metrics on trusted networks. The Compose database role bootstraps the development database; do not reuse that privileged role for other workloads.

For direct browser ingestion, set `LOGLINE_INGEST_ORIGINS` to a comma-separated list of exact origins (scheme, host and port, no paths), for example `https://app.example.com`. The default is empty, which accepts any browser origin; set exact origins to restrict browser uploads. Requests without an `Origin` (such as server-side reporters) are always unaffected. This is a browser-origin policy, not proof of the sender’s identity: anyone with a public DSN can submit events to its project. Use separate keys for public and trusted clients and inspect the server-assigned `ingestKeyId` for attribution. Keys in one project **share its quota**: use separate projects or enforce an additional budget at your gateway if public traffic must not exhaust a trusted writer’s quota. Never expose admin or read credentials in a public client.

## Cluster deployment

Use the Kubernetes manifests with an **existing persistent PostgreSQL primary** (PostgreSQL 16 or 17). Provision a dedicated database and role allowed to create and migrate its schema. Use a TLS-verified database URL in production; stage the trust chain used by your database provider. Point **every** API at the same primary, never at an asynchronous read replica. The manifests intentionally do not install a database, public Ingress, default Secret, or cluster-wide role.

1. Create a namespace. In a private `logline-secrets.env` file, store `DATABASE_URL=postgresql://…` and `LOGLINE_ADMIN_TOKEN=…`. Use an external secret manager or the command below to inject the two values. Kubernetes Secret is not encryption: restrict RBAC, encrypt etcd at rest and rotate credentials. Rotating an environment-backed admin credential requires restarting all pods; old and new credentials may coexist during that roll. To invalidate immediately, stop old replicas before enabling the replacement. PAT and project key revocation do not require a rollout.
2. In a working copy of `deploy/kubernetes/server.yaml`, replace `ghcr.io/tellok/logline-server:replace-with-release-tag` with the **exact** release tag or manifest digest. The release deployment attachment already pins the digest. Adjust the ConfigMap generator in `kustomization.yaml` for site quotas and retention. Its changed hash rolls all replicas on `apply -k`.
3. Install and check readiness. Keep the ClusterIP private and configure your own TLS ingress/gateway, body limits, timeouts, network policy and forwarding of `Authorization` without logging the header.

```sh
kubectl create namespace logline
kubectl -n logline create secret generic logline-server-secrets --from-env-file=logline-secrets.env
kubectl -n logline apply -k deploy/kubernetes
kubectl -n logline rollout status deployment/logline-server
kubectl -n logline port-forward service/logline-server 4318:4318
```

Two stateless replicas, no affinity or worker pods. Each requests 250m CPU / 128 MiB and is limited to 1 CPU / 384 MiB; these are **starting budgets**, not measured production sizing. The host spread preference helps on multiple nodes, and the disruption budget protects one replica against voluntary eviction. RollingUpdate allows one surge replica and no unavailable replica. Liveness `/health` checks the process; startup waits for migration; readiness `/ready` checks the primary. On SIGTERM the server stops admission and drains connections for up to 15 s (30 s pod grace). Retry unacknowledged batches with their original IDs through load balancer changes. Do not assume a graceful response on every connection.

## Why direct PostgreSQL batches?

| Option                                        | Acknowledgment and visibility                                                                                                                                                         | Operational tradeoff                                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chosen baseline: direct transaction**       | Authorization, quota reservation, new rows and deduplication all use the primary. The response follows COMMIT; new primary queries see accepted rows.                                 | One operational datastore. Query, ingestion and maintenance pools are separate, but share primary CPU, IOPS, WAL and disk. An unavailable primary means retry, not a successful buffered write.                                               |
| Durable broker → consumers → analytical store | A replicated durable enqueue could acknowledge before indexing; consumers need stable per-project keys, deduplication, replay, lag monitoring and a defined maximum retention window. | Independently scales ingest, bulk indexing and search; adds cluster management and a second visibility/durability boundary. In particular, an unbounded queue cannot solve a sustained capacity deficit. Not implemented or benchmarked here. |
| Redis/Valkey for grants, quotas, or buffering | A stale grant cache would break immediate revocation; an acknowledged ephemeral queue would weaken durability.                                                                        | No demonstrated need for another service: PostgreSQL serializes quota reservations per project. Re-evaluate only with measured contention and a revocation-safe invalidation model.                                                           |

[Snuba](https://getsentry.github.io/snuba/architecture/overview.html) separates consumption and analysis; [Vector](https://vector.dev/docs/architecture/buffering-model/) distinguishes bounded buffers from durability. Here, the API bounds HTTP bodies, events, concurrency and database work, returns retry guidance instead of queuing indefinitely, and stores only the durable result. This avoids broker consumer lag; it **does not** provide write availability during a database outage. A shared quota lock limits a single project's write rate even if more ingress pods are added. The client queue is bounded, not a durable spool. Reconsider a replicated broker and independent consumers if outage buffering is required, or if disk/WAL/query contention dominates after tuning batching. Do not infer that this baseline outperforms a broker or that scale-out is linear.

## Capacity, retention and recovery

- Size connections for `(INGEST_CONCURRENCY + QUERY_CONCURRENCY + 2) × (replicas + maxSurge)` plus operator and database reserve. Defaults give up to 54 API connections for two replicas during rollout. Scale on sustained per-pod in-flight saturation/CPU **and** acceptable primary headroom; watch p95/p99, pool wait, 429 (per-project quota), 503 (admission/storage), DB CPU, WAL flush latency, autovacuum progress, IOPS and free space. Scale the primary or isolate expensive read workloads before adding replicas to an already saturated primary. Do not route authorization to stale replicas.
- Scrape `GET /metrics` on each pod with the administrator bearer, not through a randomly balanced Service; protect this scraper like an administrator. Track inserted events/bytes separately from accepted IDs (replays), rejected/retryable events, request-duration histograms and in-flight counts. There is no server-side delivery backlog; monitor retry queues and loss at each client too.
- Size storage from observed **on-disk** bytes per event × sustained ingest × retention, plus indexes, WAL, backups, replica copy and vacuum headroom. Retention uses receipt time; deletes run in bounded slices, not as a hard disk quota. Monitor the oldest retained receipt and purge rate. Full-disk failure is not overload protection. Reducing retention deletes data and eventually ends deduplication for that ID.
- Keep `fsync`/`synchronous_commit` enabled and use durable storage. Use managed HA with synchronous replication if a database node loss must have zero RPO. Back up the **whole** database (events, grants, project key and PAT metadata, HMAC keys and saved views); configure PITR/WAL archival, test restore in isolation, verify scoped search and grants before changing traffic. Do not restore into a live primary. A point-in-time restore can resurrect revoked grants, PATs or project keys; reconcile authorization and rotate secrets before reopening. A pod restart is not a test of database HA, PITR or region failure.

## Reproduce the workload on a disposable deployment

The Node driver `packages/logline-server/bench/load.mjs` creates one reader and read-only PAT, and **new projects each with its own upload key per run**; use a fresh dedicated database. Set `BENCH_DISPOSABLE=yes`, `LOGLINE_ADMIN_TOKEN` and `BENCH_URLS` (comma-separated replica URLs, not admin credentials). Set `BENCH_MCP=1` on an MCP-enabled server to include authenticated tool calls. The client paces offered batches without building an unbounded queue and retries at most twice, respecting `Retry-After`. It reports unacknowledged/deferred work separately. JSON includes HTTP status counts, request and end-to-end latency, accepted events and serialized request-body bytes per second (not TCP bytes), sampled time from acknowledgment to detail query and whether the returned `ingestKeyId` matches the actual writer, per-project acknowledged vs stored counts after replay, and independent cross-replica revocation checks for the read PAT and a project key. A nonzero exit or missing evidence must not be counted as a passing run.

**Predefined local qualification target, not an SLA:** 24 active projects, 6 writers × 50 events/batch, ~350–400 JSON bytes/event, 120 s, offered 1,000 events/s, three concurrent readers polling filtered search, chart, grouping, refresh, bounded export and optional MCP at 100 ms think time. Target ≥950 accepted events/s and ≥320 KiB/s, upload and read p95 <150 ms / p99 <500 ms, sampled ack-to-visible p99 <500 ms, zero incorrect acknowledgments, duplicates or missing accepted rows. Compare no-reader and single-replica runs at the same offered rate. For a 60 s, 4,000 events/s burst direct 75% of writers to one project: expect explicit quota responses, cold projects still progressing and no silent loss; **not** 4,000 accepted/s through a 60,000/minute hot-project quota. For a storage fault expect 503/retry, bounded in-flight work and new successful writes within 15 s of primary recovery. If a containerized cluster shares the load generator host, note interference instead of extrapolating results.

```sh
export BENCH_DISPOSABLE=yes BENCH_MCP=1
# Export LOGLINE_ADMIN_TOKEN securely; set BENCH_URLS to the actual replica URLs.
node packages/logline-server/bench/load.mjs > steady.json
READERS=0 node packages/logline-server/bench/load.mjs > control.json
BENCH_URLS=http://127.0.0.1:4318 node packages/logline-server/bench/load.mjs > single.json
HOT=1 RATE=4000 WRITERS=8 SECONDS_TO_RUN=60 node packages/logline-server/bench/load.mjs > hot.json
```

To expose both replicas locally, create a Compose override containing `services: {server: {ports: !override ['127.0.0.1::4318']}}`. Start with `docker compose -f compose.yml -f override.yml up --build -d --scale server=2 --wait`; use the same `-f` options with `port --index 1 server 4318` and `--index 2` to discover the two URLs. For a 45 s outage run, after fixture setup and the `load-start` message, stop **only the disposable** `db` service for 8 s, start it, and time `/ready` until healthy. Do not stop unrelated Docker containers. Record peak CPU/RSS (`docker stats`) and `pg_total_relation_size('log_events')` before/after; document shared-host and sampling limitations. For a live cluster rollout, use a dedicated two-replica namespace prefixed `logline-bench-` and run:

```sh
BENCH_DISPOSABLE=yes KUBE_CONTEXT=kind-logline-test BENCH_NAMESPACE=logline-bench-test \
  bash packages/logline-server/bench/kubernetes-rollout.sh
```

The probe writes through one pod and reads through the other, writes via the Service during `rollout restart`, verifies each acknowledged ID on replacement pods, replays an event and removes the read grant, checking that both new replicas immediately deny the PAT while the writer can still replay. It then revokes the project key and checks that neither new replica accepts it. It uses an ephemeral probe pod with admin access in that test namespace. Delete disposable workloads and storage after recording results.

## Qualification evidence

[Raw JSON reports and drivers](https://github.com/tellok/logline/tree/master/packages/logline-server/bench) include per-operation percentiles, counts for each project and per-container resource samples. Run `node packages/logline-server/bench/qualify.mjs steady.json` against a two-replica mixed steady report: it prints a PASS/FAIL for every predetermined goal and exits nonzero on a miss. A passing correctness check alone is not a performance qualification.

### Current DSN protocol: two replicas, mixed workload

[Raw DSN report](https://github.com/tellok/logline/blob/master/packages/logline-server/bench/results/dsn-v2-mixed.json). **Correctness passed; 6/9 gates passed, so this is not a performance pass.** On a fresh dedicated PostgreSQL 17.12 volume, two native arm64 API containers running Node 24.22.1 shared a Docker Desktop host with the driver and other activity. The default 24-project, 120-second profile included 500 MCP reads. All 113,450 generated events were acknowledged and reconciled after replay; all 57 sampled details returned the expected server-assigned `ingestKeyId`. A key targeting a different project received 403. Both replicas returned 401 for the revoked read PAT and for the revoked project key.

The run achieved **944.76 events/s** (goal ≥950) and **338.06 KiB/s** (goal ≥320). Upload p95/p99 **232.83/786.93 ms** missed the <150/<500 ms goals; query p95/p99 **52.63/182.85 ms** and ack-to-visible p99 **97.36 ms** passed. Driver exit: 0; qualifier exit: 1. The current run did not remeasure hot bursts, database outages, or Kubernetes rolling replacement. Do not infer a performance regression from non-isolated runs.

## Release image

Only a verified merged version release runs the image job; preparing a version PR does not build or publish. The job pushes one OCI index for `linux/amd64` and `linux/arm64` to `ghcr.io/tellok/logline-server:<exact-release-tag>`, checks the tag digest and both descriptors, pulls both platforms, copies that exact index and blobs into an OCI archive, and attaches the archive, deployment tarball and SHA-256 checksums to the GitHub Release. The pull command is added to its notes. The deployment bundle contains the Compose file, env template, Kubernetes kustomization and operations guides. From the unpacked bundle use `docker compose up -d --wait` (no build) or apply `-k kubernetes`.

```sh
docker pull ghcr.io/tellok/logline-server:<exact-release-tag>
docker buildx imagetools inspect ghcr.io/tellok/logline-server:<exact-release-tag>
sha256sum -c logline-server.sha256
# Air-gapped: extract logline-server.oci.tar.gz to an empty directory, then copy to a local registry:
oras cp --recursive --from-oci-layout ./image:<exact-release-tag> registry.example/logline-server:<exact-release-tag>
```

Do not use a guessed `latest` tag. Pullability of a **published** GHCR tag and release attachments can only be verified on a real release, not from a PR build. The repository owner must enable package write access for Actions and grant the intended consumers read access to the GHCR package.
