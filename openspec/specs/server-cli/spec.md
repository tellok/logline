# Logline Server CLI

## Purpose

Define the terminal client for self-hosted Explorer queries. See the [CLI guide](../../../docs/cli.md).

## Requirements

### Requirement: Connect to Explorer with a user PAT

The `logline-server-cli` executable SHALL accept the deployment URL and PAT via `LOGLINE_URL` and `LOGLINE_AUTH_TOKEN`, with explicit flag overrides. It SHALL support proxy prefixes, require HTTPS for remote connections, and authenticate using a bearer header.

#### Scenario: Override the deployment

- **WHEN** the caller supplies URL or token flags alongside configured environment variables
- **THEN** each supplied flag overrides the corresponding environment variable.

### Requirement: List, inspect and correlate logs

The CLI SHALL expose `project list`, `log list`, `log view`, and `log context`. Log listing SHALL default to the last hour, newest first, with 50 rows. It SHALL support time range, severity, repeatable project and environment filters, trace, literal message substring, sorting, and paging.

#### Scenario: Page a filtered log listing

- **WHEN** the API provides a next-page cursor for the selected query
- **THEN** the CLI exposes the cursor so the caller can rerun the same query with it.

### Requirement: Support machine-readable output and generic reads

The CLI SHALL provide readable log output by default and preserve the original successful body with `--raw` or `--json`. It SHALL expose `api` for supported Explorer read routes and accept JSON from an argument, file, or stdin for POST queries.

#### Scenario: Report a command or API error

- **WHEN** argument parsing or an API request fails
- **THEN** the CLI reports the error to stderr and exits with a nonzero status.
