# Log investigation over MCP

## Purpose

Define the Server MCP interface for read-only log investigation. See the [MCP guide](../../../docs/server-mcp.md).

## Requirements

### Requirement: Offer stateless Streamable HTTP

When enabled, `POST /mcp` SHALL authenticate every request with a `logs:read` PAT, reject browser Origin requests, and accept one JSON-RPC message with the prescribed media types. It SHALL offer protocol version `2025-06-18`, return JSON responses, and require no server session.

#### Scenario: Complete initialization

- **WHEN** an authenticated client sends `initialize` and then `notifications/initialized`
- **THEN** initialization returns the offered version and tools capability, and the notification returns HTTP 202 without a body.
- **AND** later requests can be served by any replica using the protocol version header.

### Requirement: Reuse scoped Explorer reads

MCP SHALL expose the `logline_server_` tools for projects, selectors, fields, rows, series, groups, detail, and context. It SHALL use Explorer authorization and query execution and bound each tool result to 512 KiB.

#### Scenario: Query after access is revoked

- **WHEN** the owner loses access after tool discovery
- **THEN** calling a tool for the revoked project fails under the current grant decision.
