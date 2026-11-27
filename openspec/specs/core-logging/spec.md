# Core logging

## Purpose

Define the public Logline v2 logging API, record construction, masking, and plugin dispatch. See the [library README](../../../README.md) and [v2 migration guide](../../../docs/migration-v2.md).

## Requirements

### Requirement: Named logging and structured records

Logline SHALL expose `TRACE`, `DEBUG`, `LOG`, `WARN`, and `ERROR` in that severity order, plus a level-specific logger factory. It SHALL accept positional arguments and structured log input and build a record with the severity, arguments, formatted output, and timestamp supplied by the configured clock.

#### Scenario: Log a formatted message

- **WHEN** an enabled call passes a format string and its arguments
- **THEN** the logger prints the severity prefix and message to the corresponding console method and dispatches the structured record to installed plugins.

#### Scenario: Disable a structured call

- **WHEN** a structured log input sets `enable: false`
- **THEN** the call emits neither console output nor a plugin event.

### Requirement: Configuration and dispatch

`configureLogline` SHALL merge supplied configuration fields. The package SHALL expose read and reset operations. The global filter SHALL run before throttling, console output, and plugin dispatch. Throttling SHALL support a numeric interval, a custom key, or a disabled state, and SHALL honor an explicit record key before the configured key.

#### Scenario: Drop a filtered or throttled record

- **WHEN** the filter rejects a record or the same throttle key is used again inside its interval
- **THEN** the logger produces neither console output nor a plugin event for that record.

#### Scenario: Dispatch to plugins

- **WHEN** a record is emitted
- **THEN** the logger invokes installed `onLog` hooks without waiting for asynchronous delivery.
- **AND** a throwing or rejecting hook does not prevent the other hooks from being invoked.

### Requirement: Tag precedence and masking

Logline SHALL support configured tags, imperative global mutations, active scopes, and per-call tags. It SHALL merge them in that order, with scopes applied from outer to inner and later entries winning. A record SHALL contain at most 16 valid tag entries. Tag keys SHALL match `^[A-Za-z_][A-Za-z0-9_-]{0,63}$`, string values SHALL be nonempty and capped at 256 code units, and sensitive keys and values SHALL pass through masking.

#### Scenario: Apply nested scopes

- **WHEN** a call supplies a tag also set globally and in nested `withScope` callbacks
- **THEN** the per-call value wins on that record.
- **AND** without a per-call value, the innermost active scope wins.

#### Scenario: Leave a scope

- **WHEN** a synchronous callback returns or throws, or an asynchronous callback settles
- **THEN** its scope is detached and the callback result or error is preserved.
- **AND** overlapping asynchronous scopes may share tags while they are active.

#### Scenario: Mask known sensitive values

- **WHEN** recognized sensitive names occur in structured tag data or in supported string key-value forms
- **THEN** their values are masked.
