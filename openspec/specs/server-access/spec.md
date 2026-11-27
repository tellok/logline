# Server administration and access

## Purpose

Define credential boundaries, administrative resources and live authorization across replicas. See the [administration API](../../../docs/server-admin.md).

## Requirements

### Requirement: Separate credentials by operation

The deployment administrator bearer SHALL authorize management routes. User PATs SHALL authorize read operations through `logs:read` and current project grants. Project keys SHALL authorize only uploads to their assigned project. The server SHALL persist PAT and project key digests and expose their secret values only at issuance.

#### Scenario: List or revoke a credential

- **WHEN** the administrator lists or revokes user PATs or project keys
- **THEN** lists contain metadata without secret values or digests, and repeated revocation returns 204.

### Requirement: Manage resources and grant relationships

The administrator API SHALL expose users, projects, flat teams, team membership, direct user grants, team grants, and grant-source explanations. Relationships SHALL use immutable UUIDs. Resource lists SHALL use cursor pagination.

#### Scenario: Rename a project

- **WHEN** an administrator updates a project slug or display name
- **THEN** grants, saved views, and event identity continue to use the same immutable project ID.

### Requirement: Resolve live permissions on the primary

A read request SHALL use the intersection of token scope and the union of direct and current team grants. The primary SHALL be the authorization source. Authorization after commit SHALL observe grant, membership, token, and user changes across replicas.

#### Scenario: Revoke one of several grant sources

- **WHEN** one grant source is removed and another still grants the same operation
- **THEN** the user retains the permission.
- **AND** once the last source is removed, new requests to the project are denied.

#### Scenario: Disable a user

- **WHEN** an administrator disables a user
- **THEN** every PAT owned by the user fails subsequent authentication.
- **AND** re-enabling the user restores unrevoked PATs.

### Requirement: Migrate v1 access and event data

The v2 database migration SHALL serialize startup schema changes and preserve project IDs, event IDs, and stored event JSON. It SHALL remove the retired service column and upload permissions while preserving read access from mixed scopes and grants.

#### Scenario: Upgrade credentials from v1

- **WHEN** a v1 deployment migrates to v2
- **THEN** write-only PATs become revoked and no project key is derived from an old PAT.
