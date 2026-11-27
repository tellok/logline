# Asynchronous reporting

## Purpose

Define transport-agnostic, best-effort delivery of live application log records. See the [reporting reference](../../../docs/reporting.md).

## Requirements

### Requirement: Opt-in, bounded event intake

A reporting plugin SHALL sample and take a detached, bounded, sanitized event snapshot during ordinary log dispatch. It SHALL preserve the stable ID and original timestamp through retries and sanitize transform output again. Each instance SHALL own its queue, limits, metrics, and transport. Sending SHALL occur asynchronously.

#### Scenario: Record exceeds the queue or event limits

- **WHEN** the reporter is full or the incoming event cannot fit within its allowed batch size
- **THEN** that event is dropped and retained work stays queued or in flight.

#### Scenario: Events outside normal dispatch

- **WHEN** logs are only in IndexedDB history, the startup cache, or a browser error captured directly by the persistence plugin
- **THEN** the reporter does not enqueue them.

### Requirement: Acknowledge and retry by ID

A transport result SHALL partition the submitted IDs exactly once into accepted, retryable, or permanently rejected arrays. The reporter SHALL release accepted and rejected entries, retry eligible entries under finite age and attempt limits, and apply bounded backoff. A valid retry-after hint SHALL delay new requests to that destination.

#### Scenario: Handle an untrustworthy acknowledgement

- **WHEN** a transport times out, fails, or returns missing, duplicate, or unknown IDs or a malformed retry hint
- **THEN** the reporter treats the batch as retryable within the configured limits.
- **AND** invalid hints do not establish a destination cooldown.

### Requirement: Provide explicit lifecycle control

The reporter SHALL provide metrics, `flush`, `pause`, `resume`, and `dispose`. Flush SHALL track work in scope at call time with a bounded wait and respect scheduling and pause. Disposing SHALL abort active requests and discard outstanding work.

#### Scenario: Flush with concurrent logging

- **WHEN** additional log entries arrive after a flush starts
- **THEN** they may share a batch but do not extend the flush cutoff.
- **AND** a flush timeout leaves outstanding delivery eligible to continue.

#### Scenario: Remove a plugin from configuration

- **WHEN** the application replaces the configured reporter or resets Logline configuration
- **THEN** new dispatch to the removed instance stops and its existing queue remains under its own lifecycle controls.
