# Logs Explorer

## Purpose

Define the HTTP query, discovery, visualization, refresh, saved-view, and export contracts. See the [Explorer reference](../../../docs/server-explorer.md).

## Requirements

### Requirement: Scope each query to current permissions

The Explorer SHALL require an authorized user PAT whose owner has current project grants. Omitting project selection SHALL search all currently readable projects. Explicit UUID selection SHALL be authorized as a whole. The query model SHALL support relative or absolute event-time ranges, exact environment filters, and bounded Boolean field predicates.

#### Scenario: Request an inaccessible project

- **WHEN** one explicit project UUID is unknown or inaccessible
- **THEN** the Explorer returns 403 for the request.

### Requirement: Discover, page and correlate events

The Explorer SHALL provide project discovery, project/environment selectors, field discovery, row projections, detail, and context. Rows SHALL carry canonical project/event identities even with projections and use signed continuation cursors for deterministic timestamp/project/event ordering. Discovery and row queries SHALL expose their applicable limits.

#### Scenario: Continue a projected rows query

- **WHEN** a client sends the returned cursor with the same query shape and sort
- **THEN** it receives the next page under the cursor's resolved time range.

#### Scenario: Correlate an event

- **WHEN** the caller requests nearby, trace, or session context for a visible event
- **THEN** context is bounded to its project and time window and excludes the anchor.

### Requirement: Aggregate and export bounded results

The Explorer SHALL provide grouped and bucketed count, sum, and average under the same filter and grant rules. It SHALL support synchronous bounded row or group exports as CSV or JSONL, with truncation indicators.

#### Scenario: Hit an export budget

- **WHEN** the next record would exceed the export's row or byte budget
- **THEN** the result stops at a complete record and reports the limiting budget.

### Requirement: Incrementally refresh safely

The Explorer SHALL start refresh with an initialization cursor. Subsequent polls SHALL advance a safe frontier based on the oldest active PostgreSQL transaction so a concurrently committed event is not skipped because it committed out of allocation order.

#### Scenario: Poll while a transaction holds the frontier

- **WHEN** an active transaction prevents safe advancement
- **THEN** the response can mark `pendingTransactions` and continue with a cursor.

### Requirement: Save query definitions with live access

The Explorer SHALL persist named definitions with a version and private or link visibility. Only the owner SHALL modify or delete a view. Link sharing SHALL require explicit project IDs and current access for the viewer. A view SHALL store the query definition rather than its results.

#### Scenario: Edit a stale version

- **WHEN** the owner submits an update based on an older version
- **THEN** the Explorer returns 409 `version_conflict` and preserves the newer definition.
