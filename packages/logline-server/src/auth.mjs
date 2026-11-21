import { createHash, timingSafeEqual } from 'node:crypto';

export function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** Return the request's raw bearer credential or undefined (not an identity). */
export function bearer(req) {
  const value = req.headers.authorization;
  return typeof value === 'string' ? /^Bearer ([^\s,]+)$/i.exec(value)?.[1] : undefined;
}

export const digest = (secret) => createHash('sha256').update(secret).digest();
export const validId = (value) =>
  typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const unauthenticated = () => httpError(401, 'unauthenticated', 'A valid bearer credential is required');

/** Validate the separately injected bootstrap credential. No user identity or data-plane privileges are returned. */
export function requireAdmin(token, adminToken) {
  if (
    typeof adminToken !== 'string' ||
    Buffer.byteLength(adminToken) < 32 ||
    adminToken.startsWith('llpat_') ||
    !token ||
    !timingSafeEqual(digest(token), digest(adminToken))
  )
    throw unauthenticated();
}

/** Authenticate a PAT and resolve current, operation-scoped projects from the primary in one snapshot.
 * Omit projectIds for discovery; specify them for all-or-nothing authorization (no existence oracle).
 * Pass a pg Pool, or a checked-out client for a request transaction. Never cache the result across requests.
 */
export async function authorize(db, token, scope, projectIds) {
  if (typeof token !== 'string' || !/^llpat_[A-Za-z0-9_-]{43}$/.test(token)) throw unauthenticated();
  if (!['logs:read', 'logs:write'].includes(scope)) throw new Error('Invalid authorization scope');
  if (projectIds !== undefined && (!Array.isArray(projectIds) || !projectIds.every(validId)))
    throw httpError(400, 'invalid_project_id', 'Expected project UUIDs');
  const ids = projectIds === undefined ? null : [...new Set(projectIds.map((id) => id.toLowerCase()))];
  const { rows } = await db.query(
    `SELECT u.user_id AS "userId", ($2 = ANY(t.scopes)) AS allowed,
      p.project_id AS "projectId", p.slug, p.display_name AS "displayName"
    FROM user_tokens t JOIN users u USING(user_id)
    LEFT JOIN LATERAL (
      SELECT projects.* FROM projects JOIN (
        SELECT DISTINCT project_id FROM project_access_sources
        WHERE user_id=u.user_id AND $2 = ANY(permissions) AND ($3::uuid[] IS NULL OR project_id=ANY($3))
      ) permitted USING(project_id)
    ) p ON ($2 = ANY(t.scopes))
    WHERE t.secret_digest=$1 AND t.revoked_at IS NULL AND u.enabled
    ORDER BY p.project_id`,
    [digest(token), scope, ids],
  );
  if (!rows.length) throw unauthenticated();
  const projects = rows
    .filter((row) => row.projectId)
    .map(({ projectId, slug, displayName }) => ({ projectId, slug, displayName }));
  if (!rows[0].allowed || (ids && projects.length !== ids.length))
    throw httpError(403, 'forbidden', 'Operation not permitted');
  return { userId: rows[0].userId, projects };
}
