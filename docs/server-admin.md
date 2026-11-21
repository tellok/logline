# Server administration and project access

[简体中文](./server-admin.zh-CN.md) | [README](../README.md)

## Three credentials, separate boundaries

The operator generates at least 32 random bytes (e.g. `openssl rand -hex 32`) and injects the encoded value as `LOGLINE_ADMIN_TOKEN` on every ingress replica. Use printable non-space ASCII; do not use a comma or the reserved `llpat_` or `llpk_` prefix. There is no default or login account. Use TLS. Send this secret only as `Authorization: Bearer <admin-secret>` on administrative requests. Do not embed it in a browser, send it in URLs, or log authorization headers or token-issuance responses. A future admin console needs a trusted server-side backend with its own operator authentication. Rotate the deployment secret on **all** replicas; retire old replicas before considering the old secret invalid everywhere.

Personal access tokens (PATs) belong to individual users, not teams or projects. Each PAT is 256 random bits encoded for HTTP; only its SHA-256 digest is stored. The secret is returned **only at issuance**. To replace a lost PAT, issue a new one and revoke the old token by ID. PATs are exclusively for read APIs (Explorer and MCP), not upload or admin; the bootstrap credential cannot upload, search, export, or call MCP.

For every read request, the server authenticates the PAT against the shared PostgreSQL **primary**, checks the user is enabled, then resolves current project access. For each project:

```text
allowed operations = PAT scopes ∩ (direct permissions ∪ permissions from each current team)
```

Membership alone grants nothing. No project list is captured at issuance. Grant, membership, token and user changes take effect on requests authorized after commit, including on other replicas; an already-authorized in-flight request may finish. Disabling a user blocks **all** their PATs; enabling restores unrevoked PATs. Revoking a PAT is permanent and independent of other PATs. A project rename does not alter authorization, log identity or saved query scope: all use the immutable `projectId`.

A **project key** (`llpk_` + 32 random bytes encoded as unpadded base64url) is write-only and belongs to exactly one immutable project, independent of membership or who runs the uploader. Only its SHA-256 digest is persisted. The server checks the key on the shared primary for each upload. It cannot be used as a PAT or as an administrator credential.

## HTTP contract

All paths below are relative to `/api/v1/admin`. All require the administrator bearer credential. Send UTF-8 `application/json` for nonempty bodies. Resource IDs are server-generated UUIDs. Unknown body keys are not accepted on create/update. Responses are JSON unless `204 No Content`; responses are not cacheable.

| Resource     | Endpoints                                                                          | Body / result                                                                                                                                                                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users        | `GET/POST /users`, `GET/PATCH /users/{userId}`                                     | `{userId,displayName,enabled}`. Create with `displayName`, optional `enabled` (default `true`). Patch either editable field.                                                                                                                                                  |
| Projects     | `GET/POST /projects`, `GET/PATCH /projects/{projectId}`                            | `{projectId,slug,displayName}`. Create with `slug` and `displayName`; patch either. `slug` is unique across replicas and matches `[a-z0-9_-]{1,80}`. `displayName` accepts Unicode, e.g. `支付服务`, and need not be unique. Use IDs, not slugs, in API paths and PAT grants. |
| Teams        | `GET/POST /teams`, `GET/PATCH/DELETE /teams/{teamId}`                              | `{teamId,displayName}`. Create or rename with `displayName`. Delete cascades to membership and team grants, not users, projects, logs, tokens, or other grant sources.                                                                                                        |
| User tokens  | `GET/POST /users/{userId}/tokens`, `DELETE /users/{userId}/tokens/{tokenId}`       | Create with `{scopes,label?}`. Metadata is `{tokenId,userId,scopes,label,issuedAt,revokedAt}`. Creation adds `secret`; listing never returns the secret **or digest**. Timestamps are UTC ISO strings; `revokedAt:null` means not revoked. Repeated revoke returns `204`.     |
| Project keys | `GET/POST /projects/{projectId}/keys`, `DELETE /projects/{projectId}/keys/{keyId}` | Create with `{name}`. Metadata: `{keyId,projectId,name,issuedAt,revokedAt}`. **Only** creation returns the raw `key` as well. Listing never reveals the key or digest; repeated revocation returns `204`.                                                                     |

Names and optional supplied labels must be nonblank Unicode strings of at most 200 code points. `permissions` and `scopes` must be `["logs:read"]`; user and team grants do not authorize ingestion. Create returns `201` and a resource, patch returns `200` and a resource, delete returns `204`. Projects and users are not deletable through this API.

### Memberships, grants and explanations

| Workflow                         | Read                                                                                                                                                                                                                                                                         | Mutation                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User ↔ project **direct** grants | `GET /users/{userId}/memberships` returns projects plus `permissions`; `GET /projects/{projectId}/members` returns users plus `permissions`.                                                                                                                                 | `PUT/DELETE /projects/{projectId}/members/{userId}`                                                                                                                      |
| User ↔ team membership           | `GET /teams/{teamId}/members` returns users; `GET /users/{userId}/teams` returns teams.                                                                                                                                                                                      | `PUT/DELETE /teams/{teamId}/members/{userId}`                                                                                                                            |
| Team ↔ project grants            | `GET /teams/{teamId}/projects` returns projects plus `permissions`; `GET /projects/{projectId}/teams` returns teams plus `permissions`.                                                                                                                                      | `PUT/DELETE /projects/{projectId}/teams/{teamId}`                                                                                                                        |
| Effective permission explanation | `GET /users/{userId}/access` returns projects plus the union of `permissions`. `GET /users/{userId}/access/{projectId}` returns the individual sources `{sourceId,type,teamId,teamName,permissions}`. `type` is `direct` or `team`; team fields are null for a direct grant. | Derived from all three relationships, never directly editable. These views explain the user's grants (even if disabled); token validity and scope are additional checks. |

A grant `PUT` body is `{"permissions":["logs:read"]}`; it creates or **replaces** the set. Membership `PUT` needs no body (or `{}`). Both return `204` even when unchanged. Deleting an association needs no body, returns `204`, and returns `404` if absent. Removing a grant doesn't remove matching access inherited through another source. All relationships use stable IDs; teams are flat.

### Listing and failures

All lists, including sources and token metadata, return `{items,nextCursor}`. Use `?limit=50&cursor=<nextCursor>`; omit `cursor` initially. Limit is `1–100`, default `50`. Results are ordered by ascending entity UUID (source ID for explanations). `nextCursor:null` is the last page. Cursors are exclusive keyset positions, not snapshots; changes between requests may change the result set. Root `/users`, `/teams`, `/projects` lists also accept `q` (case-insensitive literal substring, up to 200 characters; searches display name and, for projects, slug). There is no alphabetical ranking or free-form SQL.

Errors are `{error:{code,message}}`. Wrong credential on management or invalid/revoked/disabled PAT: `401`. Valid PAT missing a scope or project grant: `403`. Invalid input: `400`; missing resource: `404`; unsupported method: `405`; duplicate slug: `409`; body too large: `413`; overloaded/unavailable: `503` with retry guidance. A multi-project query naming an inaccessible project is denied as a whole. The API does not provide self-service signup, passwords, browser sessions, nested teams, team admins, or anonymous sharing.

## Provision one uploader

From a trusted backend, perform these requests with the administrator bearer credential:

1. `POST /projects` with `{"slug":"payments-api_v2","displayName":"支付服务"}`; retain `projectId`.
2. `POST /projects/{projectId}/keys` with `{"name":"Payments production"}`. Save the returned `key` immediately and retain `keyId` for revocation. No user, team, or PAT is required.
3. Construct the reporter's configuration DSN as `https://<key>@<host>[/prefix]/<projectId>` using the **public deployment address you control**. HTTP is supported only for loopback development. The server does not guess the URL from request headers, and the DSN is never the HTTP request URL. See the [ingestion API](./server-ingestion.md).
4. To rotate, issue a second named key, deploy it, and `DELETE /projects/{projectId}/keys/{oldKeyId}`. Other keys remain valid. Revocation affects requests authorized after commit on every replica; an in-flight authorized request may finish. For investigation, issue a separate `logs:read` PAT to a user with project read access.

## Upgrade from schema v1

Back up the database and drain **all v1 replicas** before starting v2; do not overlap incompatible server versions. At startup v2 performs a transaction under a shared migration lock. It preserves projects, event rows, original event JSON and IDs, and removes the retired `log_events.service` column. The old service labels are not copied elsewhere. Existing read scopes/grants survive; mixed scopes/grants become read-only. Write-only grants are removed; write-only PATs are retained as revoked records with no scopes, never promoted to readers. No key is generated from an old PAT. Issue fresh project keys, configure DSNs, and switch clients to the new envelope before resuming uploads. Restoring v1 after this migration requires restoring your backup.
