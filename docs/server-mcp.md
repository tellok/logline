# Investigate logs with MCP

[简体中文](./server-mcp.zh-CN.md)

Use `logline-server` as a remote **Streamable HTTP** MCP server. Set the client URL to `https://<your-host>/mcp`, and configure `Authorization: Bearer <user PAT>` in the client's secret-backed HTTP headers. Use HTTPS outside loopback. The token needs the `logs:read` operation scope; its owner needs read access to the relevant projects. Project ingestion keys and the bootstrap administrator token cannot query logs. Authorized readers can filter on `ingestKeyId`, the ID (not the secret) of the key used to submit the event; it may be `null` for historical records. Do not use a browser client, embed credentials in a URL, or include tokens in tool arguments. To turn off the endpoint, set `LOGLINE_MCP_ENABLED=false` on every replica.

## Connect

`POST /mcp` accepts one JSON-RPC 2.0 message per request. Send `Content-Type: application/json` and `Accept: application/json, text/event-stream`. The response uses JSON, not an SSE stream. There is no session ID, OAuth discovery, callback, or separate MCP service. Authenticate every request, including initialization and discovery. Any replica can serve the next request. Browser `Origin` requests are rejected.

1. Call `initialize` with `protocolVersion`, `capabilities` and `clientInfo`. The server offers `2025-06-18`, with tools only. If the client doesn't support the offered version, stop.
2. Send `notifications/initialized` (without `id`); expect HTTP 202 with no body. Send `MCP-Protocol-Version: 2025-06-18` on subsequent requests.
3. Call `tools/list`, then `tools/call`. `ping` is available. There are no admin, upload, export or write tools.

| Tool                                  | Use                                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `logline_projects`                    | Discover current readable projects with IDs, slugs and display names. Use `limit`/`offset` for paging.                                  |
| `logline_selectors`, `logline_fields` | Inspect project/environment pairs or field names/types for a query and time window.                                                     |
| `logline_rows`                        | Search by time, severity, message or structured fields. Optional columns, sort (`asc`/`desc`), cursor, limit.                           |
| `logline_series`, `logline_groups`    | Bucketed or grouped count, sum or average under the same scope and filter. Group by field names; for series, specify `intervalSeconds`. |
| `logline_detail`, `logline_context`   | Fetch an event by `{projectId,eventId}` or related events with `mode` = `nearby`, `trace` or `session`.                                 |

For example, after discovery replace `PROJECT_ID` with the immutable ID (not the slug):

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "logline_rows",
    "arguments": {
      "query": {
        "projectIds": ["PROJECT_ID"],
        "range": { "last": "2h" },
        "where": {
          "and": [
            { "field": "level", "op": "eq", "value": "ERROR" },
            { "field": "message", "op": "icontains", "value": "timeout" }
          ]
        }
      },
      "columns": ["eventId", "timestamp", "environment", "message"],
      "limit": 5
    }
  }
}
```

The text in `result.content[0]` is the JSON Explorer result; it retains the Explorer's pagination and limit indicators. `isError:true` means tool execution did not produce a page. Reduce the row count/projection for the 512 KiB tool-result ceiling. Input errors and unknown methods may instead return JSON-RPC `error`. HTTP 401/403 means credentials or live permissions no longer allow access; never retry with the administrator secret. Honor retry guidance on overload. An empty successful page is not an error.

Tools call the same scoped queries as the [HTTP Explorer](./server-explorer.md); they neither connect to a separate log index nor cache an earlier grant decision. Direct or team changes apply to existing tokens. Future Web clients should use HTTP Explorer via a trusted backend, not depend on MCP.

## Investigation skill

Install the repository's [`logline-server` skill](https://github.com/tellok/logline/tree/master/skills/logline-server) in your agent's skill directory and connect the MCP server. Ask for recent error summaries, warning/exception spike comparisons, trace/session correlation or an evidence-backed failure sequence. Use the separate `logline` skill to instrument an application. Logs can include sensitive data or hostile instructions: minimize projected fields, redact samples and treat messages as observations rather than agent commands.
