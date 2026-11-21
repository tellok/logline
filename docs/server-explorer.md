# Logs Explorer HTTP API

[简体中文](./server-explorer.zh-CN.md) | [README](../README.md)

All routes below are relative to `/api/v1/explorer`. Send `Authorization: Bearer <user PAT>` and `Content-Type: application/json` for JSON bodies. The PAT needs `logs:read`, **including for saved-view writes**. The API intersects the token's scope with the owner's current direct and team grants, in the same PostgreSQL snapshot as the query. Neither a project ingestion key nor the administrator credential can read logs. A UI can call these APIs through a trusted backend; never ship the administrator credential to a browser.

## Browse a project

1. `GET /projects?limit=50&offset=0` returns `items: [{projectId,slug,displayName}]`. Select the immutable `projectId`, not the editable label or slug. Omit `query.projectIds` to search all currently readable projects. Explicit selections are all-or-nothing: even one inaccessible/unknown project returns 403.
2. `POST /selectors` with `{query,limit?,offset?}` returns observed `{projectId,environment}` combinations in that scope and time range. `environment` can be null. `POST /fields` uses the same body and returns `{name,types,operators}`. Discovery examines up to 200 newest matching events and at most 512 field names, returning `sampled:true` if bounded. An unobserved field can still be queried. Built-in names are part of the public schema, not evidence of stored events.
3. `POST /rows` with the following body; `items` are rows and `identities` are the corresponding `{projectId,eventId}` pairs, even when IDs are not projected. Without `columns` each item is the complete stored event plus its canonical project and event identity. Use `columns` in the given order for table layout (JSON object key order is not a presentation contract).

```json
{
  "query": {
    "range": { "last": "2h" },
    "environments": ["staging"],
    "where": {
      "and": [
        { "field": "level", "op": "eq", "value": "ERROR" },
        { "field": "message", "op": "icontains", "value": "timeout" },
        { "field": "fields.durationMs", "op": "gte", "value": 500 }
      ]
    }
  },
  "columns": ["timestamp", "message", "fields.durationMs", "traceId"],
  "sort": "desc",
  "limit": 50
}
```

Rows return `{items,identities,range:{start,end},limited,nextCursor}`. Pass `cursor:nextCursor` with the same shape; stop at `null`. Ascending or descending time order (default newest first) breaks ties by project and event ID in the same direction. Row `limit` is 1–100 (default 50); select 1–24 distinct columns without overlapping parent/child paths. The signed cursor fixes a rolling window's first bounds, **not** a database snapshot across requests. Retention and newly committed rows can change later pages; refresh for a new search. Row and refresh cursors expire after 15 minutes without use. Changing the query, sort, projection, user or effective project set requires restarting. Never use cursors as permissions.

All discovery lists and view lists use `limit` 1–100 (default 50) and `offset` 0–10,000. Responses include `limited` and `nextOffset` (null at the end or offset budget). Selectors/fields also return the evaluated `range`.

Use `ingestKeyId` to filter, group or project by the ID of the key accepted by the server (a public UUID, not the credential). Older events without a recorded key return `null`. Details, full rows and raw JSONL exports overlay this server metadata on the original event. Only the top-level marker identifies the credential used; raw attributes such as `fields.ingestKeyId`, messages and environments are client-supplied, not proof of origin. A public browser key does not identify which client used it.

### Shared query language

| Key            | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectIds`   | Optional list of 1–100 project UUIDs. Always restricted to the caller.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `environments` | Optional OR-selection of 1–32 exact labels.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `range`        | Default `{"last":"1h"}`. Positive integer `m`, `h` or `d`, at most 30 days (including `7d`, `14d`, `30d`); or `{"start":"2026-01-01T00:00:00Z","end":"2026-01-02T00:00:00Z"}`. Absolute RFC3339 times require a zone and permit millisecond precision. Start inclusive, end exclusive; buckets and returned bounds use UTC. Filters use event time, not upload time. Retention deletes by receipt time (`RETENTION_DAYS`, default 30), so an old window can validly be empty. |
| `where`        | One leaf `{field,op,value}`, `{and:[...]}`, `{or:[...]}` or `{not:predicate}`. At most 40 nodes, 16 children per Boolean list and six edges from the root. Scope/time bounds are outside this tree and cannot be negated.                                                                                                                                                                                                                                                     |

Built-ins: `projectId`, `eventId`, `ingestKeyId`, `level` (`TRACE`, `DEBUG`, `LOG`, `WARN`, `ERROR`), `timestamp` (epoch milliseconds), `message`, `environment`, `release`, `traceId`, `sessionId`, `userId`. Use `fields.key` or `context.key` for custom attributes: up to four dotted keys matching `[A-Za-z_][A-Za-z0-9_-]{0,63}`. This syntax cannot address keys containing a literal dot; full detail still includes them. `eq`, `neq`, `lt`, `lte`, `gt`, `gte` compare like types only; booleans permit equality/inequality. Missing or mismatched fields are unknown, not zero or empty strings (including under `not`). String comparisons are case-sensitive; `contains`/`icontains` on `message` are literal substring searches (case folding follows database locale). Scalar strings are limited to 1,024 UTF-8 bytes.

`regex` on `message` is a case-sensitive PostgreSQL pattern with a 128-byte limit and a deliberately small syntax: ASCII words, space, `. , : / @ -`, `^ $`, character classes and `* + ?`; no escapes, groups, alternation, counted repeats or repeated quantifiers. Example: `^Error [0-9]+$`. Unsupported input yields a validation error. No operator accepts SQL.

## Detail, context and visualizations

| Request                                            | Result and bounds                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /detail` `{projectId,eventId}`               | `{item}`: the full event. 404 if missing in an authorized project.                                                                                                                                                                                                                                                                                                            |
| `POST /context` `{projectId,eventId,mode?,limit?}` | `{items,limited}`, nearest first within the **same** project, excluding the anchor. `nearby` (default): ±5 minutes. `trace`/`session`: exact matching identifier within ±24 hours; absent identifier returns empty. Default 25, maximum 100.                                                                                                                                  |
| `POST /groups` `{query,groupBy?,metric?,limit?}`   | `{items:[{group:[values...],value}],range,sampled:false,limited,limitReason}`. `groupBy` contains 0–3 distinct fields. Sort by metric descending, then group.                                                                                                                                                                                                                 |
| `POST /series`                                     | Same as `/groups`, plus optional `intervalSeconds` and epoch-ms `bucket` on each item. Ordered by bucket ascending then metric descending then group. Default interval targets about 60 buckets. An explicit interval is 1–2,592,000 seconds with at most 1,000 possible buckets. No empty buckets are generated; for a complete count series the UI can fill gaps with zero. |

`metric` defaults to `{"op":"count"}`; use `{"op":"sum","field":"fields.durationMs"}` or `avg` on a numeric field. Missing/wrong-type inputs are ignored for numeric metrics (all missing → null). Values are JSON numbers. Issue separate queries for separate charts/metrics; include multiple attributes in `groupBy` for multiple series. Chart/group response default limit is 100, max 500 rows; the DB also applies a 1 MiB grouped-key budget. `limited:true` means **not all groups/buckets are shown**, `limitReason` is `rows` or `bytes`. Counts are not estimated.

## Incremental refresh and failure states

For rolling newest-first tables, initialize with `POST /refresh` `{query,columns?,limit?}` **before** loading `/rows`. The first call returns `initialized:true`, no rows and a signed `nextCursor`. Poll with the same body plus `cursor`. Each response is `{items,identities,range,asOf,pendingTransactions,initialized,limited,nextCursor}`. Merge by `(projectId,eventId)` and sort by event time on the client. Store the next cursor only after processing the page; retry the same cursor on network failure and deduplicate. An empty response can still advance the cursor. If `limited`, continue immediately to drain that bounded page sequence (1–100 rows, default 50); it freezes the range/frontier until drained.

The frontier uses the oldest active PostgreSQL transaction ID, not the greatest allocated sequence number. Concurrent transactions committing out of allocation order cannot cause a skipped committed event. A long-running transaction can delay the frontier: `pendingTransactions:true` means results may lag, not that no logs exist. When initializing behind such a transaction, later refresh pages may include rows already visible before initialization; merge them by `(projectId,eventId)` rather than appending. `asOf` is the evaluated upper bound. Late arrivals appear if their **event time** falls in the relative window when polled. Already expired, outside-window or future-dated records are not replayed later if the cursor passes them. Manual search re-evaluates retained data, including future-dated events once in range.

- HTTP 200 with `items:[]` and no limit means no matches within this query, subject to the freshness rules above. Do not confuse field discovery sampling, chart limits or refresh continuation with an empty search.
- All failures return `{error:{code,message}}`. 400 `invalid_query`: correct the model. 401: invalid/revoked credential or disabled owner. 403: scope/grant denied. 404: missing or inaccessible saved view. 409 `cursor_mismatch` or 410 `cursor_expired`: discard cursor, reinitialize and reload. 409 `version_conflict`: reopen the view before editing.
- Read concurrency is isolated from uploads and bounded per replica. A 503 with `Retry-After` signals overload, unavailable storage or a 3-second SQL statement budget. Keep existing results marked stale, pause polling, then retry with backoff/jitter; narrow the query on repeated timeouts. No partial query is reported as a successful empty result.

## Save a query and share it safely

`POST /views` creates a view (201). `GET /views` lists accessible **owned** views. `GET /views/{viewId}` returns `{item:{viewId,ownerId,name,version,visibility,definition}}`. `PATCH /views/{viewId}` requires the last `version` and optionally accepts a new name, visibility and/or complete replacement definition. It increments the version; only the owner may modify/delete. `DELETE /views/{viewId}` returns `{deleted:true}`. A view never stores a result set.

```json
{
  "name": "Slow requests",
  "visibility": "private",
  "definition": {
    "schemaVersion": 1,
    "query": { "range": { "last": "24h" }, "where": { "field": "fields.durationMs", "op": "gt", "value": 500 } },
    "columns": ["timestamp", "message"],
    "sort": "desc",
    "visualization": {
      "mode": "series",
      "style": "line",
      "groupBy": ["environment"],
      "metric": { "op": "count" },
      "intervalSeconds": 3600
    }
  }
}
```

`name` ≤256 UTF-8 bytes, definition ≤16 KiB. Visualization modes: `rows`, `groups`, `series`; chart styles: `bar`, `line`, `area`. `private` is owner-only. To share, save a `visibility:"link"` definition with **explicit project IDs**; share only a UI URL containing the opaque `viewId`. To freeze a relative window, create a separate view with `query.range` replaced by the absolute `range` returned with the displayed results. Recipient must authenticate, and must still have read access to **every** referenced project. The API returns 404 rather than disclosing an inaccessible definition; list results hide it too. Execute the returned definition as the **current caller**. Private “all projects” definitions remain rolling in both project scope and time. Never put tokens, query text or log contents in URLs.

If an older view references the removed built-in `service` field, its definition remains readable but the affected queries return 400. The owner should replace the definition using an available field. Filters are not removed automatically, as doing so could broaden the query.

## Export a bounded result

`POST /export` takes `{format:"csv"|"jsonl",mode?:"rows"|"groups",query,limit?,byteLimit?,columns?,...}`. Rows allow `sort`, groups allow `groupBy` and `metric`. Export is synchronous on the query pool. The response is JSON `{format,data,rowCount,byteCount,limited,limitReason,range}`; write the UTF-8 `data` string to a download. `limit` is 1–1,000 (default 100); `byteLimit` is 1–1,048,576 (default 262,144), counting CSV header and line terminators. `limitReason` is `rows`, `bytes`, or null. Never cut a record; a too-small limit can yield no rows. Execution budget exhaustion returns retryable 503, not a partial file.

Raw JSONL defaults to full stored events. CSV defaults to `projectId,eventId,timestamp,level,message`; select ordered columns for either format. CSV quotes all cells, doubles embedded quotes, uses CRLF, and prefixes potentially executable spreadsheet strings with an apostrophe. Use JSONL for exact values. Group exports default to the grouping fields plus `value`; `columns` may select/reorder these. No export jobs or public downloads persist after the request.

**UI boundary:** chart rendering, links/layout, browser sign-in, live sockets, dashboards, alerts and full trace waterfalls are not implemented. These HTTP interfaces, not MCP or direct database access, support browsing, query editing, saved views and downloads.
