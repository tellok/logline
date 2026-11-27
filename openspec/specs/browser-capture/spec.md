# Browser capture and persistence

## Purpose

Define local diagnostics through IndexedDB, opt-in startup capture, and click logging. See the [IndexedDB guide](../../../docs/indexeddb.md) and [click logging guide](../../../docs/click-log.md).

## Requirements

### Requirement: Local IndexedDB records and queries

The IndexedDB plugin SHALL persist structured log records and browser error events locally, retaining at most the configured number of entries. The default store SHALL be `records` with a default limit of 100,000. Automatic database naming SHALL use the resolved Vite base, then the runtime base, and fall back to `logline`. A non-root base SHALL yield `logline:<normalized-path>`.

#### Scenario: Query the database

- **WHEN** the caller queries an instance with an explicit database name
- **THEN** the instance reads that database, while the standalone `getLogs` uses automatic naming.
- **AND** the count applies to records matching the time and severity filters, with a default count of 100.

#### Scenario: Close or upgrade a connection

- **WHEN** the plugin is disposed
- **THEN** it removes browser error listeners and closes its connection.
- **AND** a connection that receives a database `versionchange` closes and stops persisting.

#### Scenario: Reuse automatic persistence

- **WHEN** Vite has installed the automatic plugin and an application subsequently creates a manual instance
- **THEN** it reuses the automatic instance and warns once that manual options are ignored.

### Requirement: Transfer opt-in startup diagnostics

HTML Interop SHALL buffer up to 1,000 startup console and global error records when enabled. IndexedDB takeover SHALL restore console methods, detach startup listeners, transfer the buffer, remove the startup globals, and make queries wait for transfer.

#### Scenario: Capture after takeover

- **WHEN** IndexedDB has taken over startup capture
- **THEN** it persists Logline calls, global errors, and unhandled promise rejections.
- **AND** ordinary console calls are outside continued capture.

### Requirement: Browser interaction logging

The click logging plugin SHALL listen for `click` on Windows and Intel Macintosh user agents and `touchstart` elsewhere. It SHALL find an ancestor with an ID or class and log its selector and bounded visible text. Installation outside a browser SHALL do nothing.

#### Scenario: Shorten captured text

- **WHEN** targeted text is an alphanumeric value of at least ten characters containing letters and digits
- **THEN** the plugin replaces it with `*`.
- **AND** longer text that does not match the heuristic is shortened to ten characters plus `...`.
