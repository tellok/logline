# Asynchronous reporting

[简体中文](./reporting.zh-CN.md)

Use a reporting plugin when a destination needs a **live, best-effort** copy of ordinary logline calls. Each instance owns its own in-memory queue, retry budget and transport. Importing `logline` does not start a reporter or attach listeners. The plugin needs neither IndexedDB nor Vite.

## Example: a custom HTTP transport

This example uses an application gateway with an intentionally simple contract: **204 means every submitted ID was durably accepted**. It is not the response contract of the Logline ingestion API, which returns per-ID acknowledgements. Authenticate callers at the gateway; keep backend credentials there, not in a browser bundle.

```ts
import { configureLogline } from 'logline';
import { createReportingLoggingPlugin, type ReportingTransport } from 'logline/plugin/reporting';

const gateway: ReportingTransport = {
  name: 'application-gateway',
  async send(events, { signal }) {
    const ids = events.map((event) => event.id);
    const response = await fetch('/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
      signal,
    });
    const accepted = response.status === 204;
    const retry = !accepted && (response.status === 408 || response.status === 429 || response.status >= 500);
    const delay = response.headers.get('Retry-After'); // This gateway uses delay-seconds.
    return {
      acceptedEventIds: accepted ? ids : [],
      retryableEventIds: retry ? ids : [],
      rejectedEventIds: !accepted && !retry ? ids : [],
      retryAfterMs: retry && delay && /^\d+$/.test(delay) ? Number(delay) * 1000 : undefined,
    };
  },
};
const reporting = createReportingLoggingPlugin({
  transport: gateway,
  sampleRate: 0.1,
  levelSampleRates: { ERROR: 1 },
  context: { release: 'demo', environment: 'staging' },
});
configureLogline({ plugins: [reporting] }); // Include any other explicit plugins here.
```

For **Sentry**, map levels, message and sanitized fields to SDK events. Assign IDs or deduplication metadata and acknowledge only what the adapter can actually guarantee: an SDK enqueue is not necessarily remote acceptance. Disable overlapping SDK retries, console breadcrumbs or automatic global-error capture as appropriate. For **ELK**, send to an authenticated ingestion service, map `timestamp` to `@timestamp`, and use the delivery ID for idempotency. If bulk indexing partially fails, classify individual items (e.g. mapping rejection vs. temporary overload); never acknowledge a whole batch solely because its HTTP status was 200.

## Options and limits (per instance)

| Option                                        |            Default | Meaning                                                                                                                                                    |
| --------------------------------------------- | -----------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`                                   |           required | Named transport; one attempt per `send(batch, { signal })` call.                                                                                           |
| `filter`, `sampleRate`, `levelSampleRates`    |    none, `1`, `{}` | Apply the synchronous predicate, then a level override or the global rate. `0` drops all; `1` keeps all before capacity checks. Decide once, not on retry. |
| `context`, `snapshotKeys`, `transform`        |               none | Explicit application context, extra data-property names to snapshot, and a synchronous redaction hook.                                                     |
| `maxQueueEvents`, `maxQueueBytes`             |       1,000; 1 MiB | Total admitted events and summed UTF-8 event JSON bytes, **including** in-flight events and retry backlog.                                                 |
| `maxBatchEvents`, `maxBatchBytes`             |         50; 64 KiB | Maximum count and encoded JSON array bytes (including brackets and commas); account separately for any transport envelope.                                 |
| `flushIntervalMs`, `maxConcurrentBatches`     |           1,000; 1 | Maximum coalescing delay for an eligible small batch; maximum active requests. Capacity, pause and cooldown still apply.                                   |
| `requestTimeoutMs`, `maxAttempts`, `maxAgeMs` | 10,000; 5; 300,000 | Abort overdue requests; attempts include the first send. Age is measured from local intake, not the supplied log timestamp.                                |
| `retryBaseMs`, `retryMaxMs`                   |        500; 30,000 | Exponential retry cap, doubled each attempt up to the maximum. Each delay is randomized between half its cap and its cap.                                  |
| `onStatus`                                    |               none | Coalesced metrics callback outside `onLog`; callback failures do not propagate.                                                                            |

Numeric limits are integers in `[1, 2147483647]`; only known levels and finite rates in `[0, 1]` are accepted. Invalid limits throw at construction. Filtering/sampling affects only this reporter, not console, IndexedDB or another reporter. Global filters, throttles and build-time level removal remain upstream. At capacity the **newest incoming event is dropped**, not an older in-flight item. An event too large for one batch is dropped on intake. `getMetrics()` exposes `queued`, `inFlight`, held `bytes`, and cumulative `accepted`, `retried` (repeat attempts started), `rejected`, `expired`, `discarded`, `sampledOut`, `overflow`, `failed`, and `lastFailure`. Internal failures never log to console. Do not emit diagnostic logs from adapters or hooks, including asynchronous callbacks that can create feedback loops.

## Snapshot and privacy

Each `ReportingEvent` has a stable string `id`, `level` (`TRACE`, `DEBUG`, `LOG`, `WARN`, `ERROR`), `timestamp` (original epoch milliseconds), `message` (formatted text including source prefixes), and optional JSON `fields` and `context`. Fields preserve timestamp components and sanitized argument details; IDs, not timestamps or arrival order, identify events. Provide release/environment/session/trace metadata explicitly. The reporter does not send the raw record or retain references to mutable arguments.

Sampling and a **bounded per-event snapshot run synchronously** before the logger returns. Batch encoding/network I/O occur later, so logging never awaits delivery. Only known data properties and those explicitly listed in `snapshotKeys` are inspected; unknown object properties are omitted rather than enumerating arbitrary objects. Use `snapshotKeys` for application-specific metadata. The built-in schema covers error details (`name`, `message`, `stack`, `cause`, `code`), common structured data (`status`, `id`, `type`, `value`, `data`, `details`, `error`, `nested`, `user`, `durationMs`, `count`), application identifiers (`environment`, `release`, `traceId`, `sessionId`, `userId`), known masked fields and the snapshot's own fields. Up to 24 extra keys may be provided (1–64 ASCII word characters, dots or hyphens; prototype and serializer keys are excluded). Per pass, the snapshot visits up to 96 values, to depth 4, with at most 16 elements per array. Strings are capped at 2,048 UTF-16 code units each, 8,192 in total; standard context identifiers are limited to 256. A final event above 64 KiB is discarded even if the transport allows larger batches. Cycles, unsupported values, accessors, Error data and oversized values are handled conservatively; missing details cannot be reconstructed. Existing masking rules are not a universal secret detector: avoid logging secrets and use `transform` to redact application-specific values (return `undefined` to discard). Transform receives a detached snapshot, and its output is sanitized again; it cannot change delivery identity or chronology. Keep hooks fast. Hook/snapshot failures affect at most that event.

## Acknowledgements and lifecycle

- Return **all three ID arrays**, forming an exact disjoint partition of the submitted IDs. A duplicate, unknown or missing ID or invalid `retryAfterMs` invalidates the entire result. Hints larger than `maxRetryAfterMs` (default 300,000 ms) are malformed: they never install a cooldown or delay unrelated batches. Increase this limit for a destination that legitimately requests longer pauses. Malformed results, transport throws/rejections and timeouts retry the batch within finite limits. Accepted and permanently rejected items are removed immediately; only retryable items remain. No reporting acknowledgement clears diagnostic IndexedDB data.
- Batches start after intake at count, byte, waiting-time or flush thresholds. Due retries alternate with fresh work. Backoff is per event; an optional nonnegative finite `retryAfterMs` establishes a minimum wait for **all new requests to this destination**, not requests already in flight. Events never occupy two active local requests. Receivers may see duplicates after timeouts or lost acknowledgements: honor abort signals, deduplicate on `id`, and reconstruct chronology from timestamps. There is no exactly-once or guaranteed-delivery promise.
- `await reporting.flush({ timeout: 5000 })` drives the ordinary scheduler for entries outstanding at call time. The default timeout is 30 s. Later logs may share requests but do not extend the cutoff. The result contains `accepted`, `rejected`, `expired`, `discarded`, `remaining`, `timedOut` for that cutoff. Timeout does not cancel delivery, bypass backoff, or override pause. A zero timeout polls without waiting. `maxFlushWaiters` (default 16) bounds simultaneous waiting calls per instance: at capacity, an additional waiting call immediately rejects with `RangeError` without starting a timer or disturbing existing flushes. Polls and empty queues never consume slots. A slot is freed on completion, timeout or disposal.
- `pause()` suspends new requests; current requests finish and intake/expiry continue. `resume()` re-enables sending. `dispose()` permanently stops intake, clears timers, aborts requests and discards outstanding events, including those in active requests. Call `flush` first for a bounded delivery attempt before shutdown; call `dispose` immediately instead to revoke consent. It cannot retract events already sent.
- Installation is idempotent (no installation work). Reuse the same instance across `configureLogline` calls. Removing/replacing it or resetting configuration stops new dispatch but does **not** dispose its existing queue. Explicitly dispose removed instances. In-memory state is lost on reload; no durable outbox, historical upload, automatic page-exit flush or consistent session sampling is provided.

**Capture boundary:** reporting receives ordinary logline plugin dispatch only. It does not consume HTML Interop's startup cache, attach global `error` / `unhandledrejection` listeners, or capture ordinary console calls after takeover. Startup and global-error records written directly by the IndexedDB plugin remain diagnostic-only; use an explicit integration for other capture sources.
