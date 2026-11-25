# Logline Server CLI

[简体中文](./cli.zh-CN.md) | [README](../README.md)

The `logline-server-cli` command queries a self-hosted Logline server through its [Explorer API](./server-explorer.md). It requires Node.js 22.12 or later and a [personal access token](./server-admin.md) with `logs:read`. The token owner's current project grants determine which logs the server returns.

## Connect and search

```sh
npm install -g logline-server-cli@beta
export LOGLINE_URL=https://logs.example.com
export LOGLINE_AUTH_TOKEN=YOUR_PERSONAL_ACCESS_TOKEN

logline-server-cli project list
logline-server-cli log list --period 2h --level error --query 'checkout timeout' --limit 20
```

Pass `--url` and `--token` to override the corresponding environment variables. The URL is the deployment root and can include a reverse-proxy prefix. Use HTTPS for remote deployments and HTTP for local loopback development. The CLI sends the token in the Bearer header for that request. Prefer an environment variable when a token would otherwise be exposed in shell history or process arguments.

`log list` searches the last hour across readable projects, newest first, with a default page size of 50 (maximum 100). Narrow it with repeatable `--project <uuid>` and `--environment <name>` flags, an exact `--trace <id>`, and a case-insensitive literal message substring via `--query`. Use `--period 2h` for a relative window or `--period '2026-01-15T00:00:00Z..2026-01-16T00:00:00Z'` for absolute bounds. Use `--sort oldest` for chronological order. If the CLI prints a next-page cursor, repeat the search with the same filters and sort plus `--cursor <cursor>`.

The default log format displays a UTC timestamp, severity, message, project ID, event ID and available correlation fields. Multiline messages are indented and severity is colored in compatible terminals. Set `NO_COLOR=1` to disable color. Use the project and event IDs from the output to inspect structured fields or find related logs:

```sh
logline-server-cli log view "$PROJECT_ID" "$EVENT_ID"
logline-server-cli log context "$PROJECT_ID" "$EVENT_ID" --mode trace
```

Context defaults to `nearby`. It also accepts `trace` and `session`, within the same project. Project listing supports `--limit` and `--offset`. Run `logline-server-cli --help` for the command and flag reference.

## Raw output and API queries

Use `--raw` (alias `--json`) for the original successful HTTP response body, including log records, range and pagination fields. Errors go to stderr and produce a nonzero exit status.

```sh
logline-server-cli log list --level error --raw | jq '.items[]'
logline-server-cli api 'projects?limit=10&offset=0'
logline-server-cli api groups --data '{"query":{"range":{"last":"2h"}},"groupBy":["level"]}'
logline-server-cli api rows --data @request.json --raw
```

`api` accepts a path relative to `/api/v1/explorer/` or the full Explorer path starting with that prefix. It uses GET for `projects`, `views`, and `views/<uuid>`, and POST for the read queries `rows`, `detail`, `context`, `selectors`, `fields`, `groups`, `series`, `refresh`, and `export`. Pass the JSON request object inline, with `--data @file`, or with `--data @-` for stdin. Generic queries and project listings default to indented JSON. Use the [Explorer API reference](./server-explorer.md) for request bodies, supported operators and response shapes.
