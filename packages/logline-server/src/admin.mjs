import { randomBytes } from 'node:crypto';
import { bearer, digest, httpError, requireAdmin, validId } from './auth.mjs';

const invalid = (message) => httpError(400, 'invalid_request', message);
const missing = () => httpError(404, 'not_found', 'Resource not found');
const methodError = () => httpError(405, 'method_not_allowed', 'Method not allowed');
const resources = new Map([
  ['users', { id: 'user_id', key: 'userId', fields: 'user_id AS "userId", display_name AS "displayName", enabled' }],
  [
    'projects',
    { id: 'project_id', key: 'projectId', fields: 'project_id AS "projectId", slug, display_name AS "displayName"' },
  ],
  ['teams', { id: 'team_id', key: 'teamId', fields: 'team_id AS "teamId", display_name AS "displayName"' }],
]);
const tokenFields =
  'token_id AS "tokenId", user_id AS "userId", scopes, label, issued_at AS "issuedAt", revoked_at AS "revokedAt"';
const operations = ['logs:read', 'logs:write'];

function object(body, allowed, required = []) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(body, k))
  )
    throw invalid(`Expected object with fields: ${allowed.join(', ')}`);
  return body;
}
function name(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    [...value].length > 200 ||
    value.includes('\0') ||
    !value.isWellFormed()
  )
    throw invalid('Expected nonblank Unicode name of at most 200 characters');
  return value;
}
function slug(value) {
  if (typeof value !== 'string' || !value.length || value.length > 80 || /[^a-z0-9_-]/.test(value))
    throw invalid('slug must contain 1–80 lowercase ASCII letters, digits, underscores or hyphens');
  return value;
}
function scopes(values) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > 2 ||
    !values.every((v) => operations.includes(v)) ||
    new Set(values).size !== values.length
  )
    throw invalid('Expected a nonempty, unique subset of logs:read and logs:write');
  return [...values].sort();
}
function checkId(id) {
  if (!validId(id)) throw invalid('Expected a UUID');
  return id;
}
function checkedParams(params, allowed) {
  for (const key of params.keys())
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw invalid('Unknown or repeated query parameter');
}

/** Keyset paginate a server-defined SELECT. No HTTP values are interpolated as SQL. */
async function list(db, params, select, args, key, searchColumn) {
  checkedParams(params, searchColumn ? ['cursor', 'limit', 'q'] : ['cursor', 'limit']);
  const rawLimit = params.get('limit') ?? '50';
  if (!/^[1-9]\d{0,2}$/.test(rawLimit) || +rawLimit > 100) throw invalid('limit must be 1–100');
  const limit = Number(rawLimit);
  let condition = 'TRUE';
  if (params.has('cursor')) condition += ` AND "${key}" > $${args.push(checkId(params.get('cursor')))}::uuid`;
  if (params.has('q')) {
    const q = params.get('q');
    if ([...q].length > 200 || q.includes('\0')) throw invalid('q is limited to 200 characters');
    condition += ` AND strpos(lower(${searchColumn}),lower($${args.push(q)})) > 0`;
  }
  const { rows } = await db.query(
    `SELECT * FROM (${select}) page WHERE ${condition} ORDER BY "${key}" LIMIT $${args.push(limit + 1)}`,
    args,
  );
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1][key] : null };
}
async function one(db, text, args) {
  const { rows } = await db.query(text, args);
  if (!rows.length) throw missing();
  return rows[0];
}
async function resource(db, type, id) {
  const spec = resources.get(type);
  return one(db, `SELECT ${spec.fields} FROM ${type} WHERE ${spec.id}=$1`, [checkId(id)]);
}

async function entity({ db, method, params, body }, type, id) {
  const { id: column, key, fields } = resources.get(type);
  if (method === 'GET' && !id) {
    const search = type === 'projects' ? `slug || ' ' || "displayName"` : '"displayName"';
    return [200, await list(db, params, `SELECT ${fields} FROM ${type}`, [], key, search)];
  }
  checkedParams(params, []);
  if (id) checkId(id);
  if (method === 'GET') return [200, await resource(db, type, id)];
  if (method === 'DELETE' && type === 'teams' && id) {
    await one(db, 'DELETE FROM teams WHERE team_id=$1 RETURNING team_id', [id]);
    return [204];
  }
  const creating = method === 'POST' && !id;
  if (!creating && !(method === 'PATCH' && id)) throw methodError();
  const keys =
    type === 'projects' ? ['slug', 'displayName'] : type === 'users' ? ['displayName', 'enabled'] : ['displayName'];
  const required = creating ? keys.filter((k) => k !== 'enabled') : [];
  object(body, keys, required);
  if (!Object.keys(body).length) throw invalid('At least one editable field is required');
  const columns = [],
    args = [];
  if (Object.hasOwn(body, 'displayName')) {
    columns.push('display_name');
    args.push(name(body.displayName));
  }
  if (Object.hasOwn(body, 'slug')) {
    columns.push('slug');
    args.push(slug(body.slug));
  }
  if (Object.hasOwn(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean') throw invalid('enabled must be boolean');
    columns.push('enabled');
    args.push(body.enabled);
  }
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const query = creating
    ? `INSERT INTO ${type} (${columns.join(',')}) VALUES (${placeholders.join(',')})`
    : `UPDATE ${type} SET ${columns.map((c, i) => c + '=' + placeholders[i]).join(',')} WHERE ${column}=$${args.push(id)}`;
  return [creating ? 201 : 200, await one(db, query + ' RETURNING ' + fields, args)];
}

// Each list is from the perspective of its parent. Grants shown here are direct, never derived.
const relations = new Map([
  ['users/memberships', ['direct_grants', 'projects', true, false]],
  ['projects/members', ['direct_grants', 'users', true, true]],
  ['users/teams', ['team_members', 'teams', false, false]],
  ['teams/members', ['team_members', 'users', false, true]],
  ['teams/projects', ['team_grants', 'projects', true, false]],
  ['projects/teams', ['team_grants', 'teams', true, true]],
]);
async function relation({ db, method, body, params }, type, id, route, otherId) {
  const [table, other, hasPermissions, writable] = relations.get(`${type}/${route}`);
  const parentColumn = resources.get(type).id;
  const { id: otherColumn, key, fields } = resources.get(other);
  if (!otherId && method === 'GET') {
    await resource(db, type, id);
    return [
      200,
      await list(
        db,
        params,
        `SELECT ${fields}${hasPermissions ? ', permissions' : ''} FROM ${table} JOIN ${other} USING(${otherColumn}) WHERE ${parentColumn}=$1`,
        [id],
        key,
      ),
    ];
  }
  checkedParams(params, []);
  if (!writable || !otherId || !['PUT', 'DELETE'].includes(method)) throw methodError();
  const args = [id, checkId(otherId)];
  if (method === 'DELETE') {
    await one(db, `DELETE FROM ${table} WHERE ${parentColumn}=$1 AND ${otherColumn}=$2 RETURNING ${otherColumn}`, args);
    return [204];
  }
  if (hasPermissions) {
    args.push(scopes(object(body, ['permissions'], ['permissions']).permissions));
    await db.query(
      `INSERT INTO ${table} (${parentColumn},${otherColumn},permissions) VALUES ($1,$2,$3) ON CONFLICT (${parentColumn},${otherColumn}) DO UPDATE SET permissions=EXCLUDED.permissions`,
      args,
    );
  } else {
    if (body !== undefined) object(body, []);
    await db.query(`INSERT INTO ${table} (${parentColumn},${otherColumn}) VALUES ($1,$2) ON CONFLICT DO NOTHING`, args);
  }
  return [204];
}
async function tokens({ db, method, body, params }, userId, tokenId) {
  if (method === 'GET' && !tokenId) {
    await resource(db, 'users', userId);
    return [
      200,
      await list(db, params, `SELECT ${tokenFields} FROM user_tokens WHERE user_id=$1`, [userId], 'tokenId'),
    ];
  }
  checkedParams(params, []);
  if (method === 'POST' && !tokenId) {
    object(body, ['label', 'scopes'], ['scopes']);
    const secret = 'llpat_' + randomBytes(32).toString('base64url');
    const data = await one(
      db,
      `INSERT INTO user_tokens(user_id,secret_digest,scopes,label) VALUES($1,$2,$3,$4) RETURNING ${tokenFields}`,
      [userId, digest(secret), scopes(body.scopes), body.label === undefined ? '' : name(body.label)],
    );
    return [201, { ...data, secret }];
  }
  if (method === 'DELETE' && tokenId) {
    await one(
      db,
      'UPDATE user_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1 AND token_id=$2 RETURNING token_id',
      [userId, checkId(tokenId)],
    );
    return [204];
  }
  throw methodError();
}

async function access({ db, method, params }, userId, projectId) {
  if (method !== 'GET') throw methodError();
  await resource(db, 'users', userId);
  if (!projectId)
    return [
      200,
      await list(
        db,
        params,
        `SELECT project_id AS "projectId", slug, display_name AS "displayName", array_agg(DISTINCT perm ORDER BY perm) AS permissions FROM project_access_sources JOIN projects USING(project_id) CROSS JOIN LATERAL unnest(permissions) perm WHERE user_id=$1 GROUP BY project_id,slug,display_name`,
        [userId],
        'projectId',
      ),
    ];
  await resource(db, 'projects', projectId);
  // Nil UUID reserves one position in the cursor namespace for the direct source.
  return [
    200,
    await list(
      db,
      params,
      `SELECT coalesce(s.team_id,'00000000-0000-0000-0000-000000000000') AS "sourceId", CASE WHEN s.team_id IS NULL THEN 'direct' ELSE 'team' END AS type, s.team_id AS "teamId", t.display_name AS "teamName", s.permissions FROM project_access_sources s LEFT JOIN teams t USING(team_id) WHERE s.user_id=$1 AND s.project_id=$2`,
      [userId, projectId],
      'sourceId',
    ),
  ];
}

/** Handle /api/v1/admin requests. Returns false outside that prefix, otherwise sends JSON or 204.
 * The host parses bounded JSON and serializes thrown HTTP errors without internal SQL diagnostics.
 */
export async function handleAdmin({ req, res, url, db, body, send, adminToken }) {
  const prefix = '/api/v1/admin';
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
  requireAdmin(bearer(req), adminToken);
  const parts = url.pathname.slice(prefix.length + 1).split('/');
  const [type, id, route, otherId] = parts;
  if (!resources.has(type) || parts.length > 4 || parts.some((p) => !p)) throw missing();
  if (id) checkId(id);
  const ctx = { db, method: req.method, params: url.searchParams, body };
  let result;
  try {
    if (!route) result = await entity(ctx, type, id);
    else if (relations.has(`${type}/${route}`)) result = await relation(ctx, type, id, route, otherId);
    else if (type === 'users' && route === 'tokens') result = await tokens(ctx, id, otherId);
    else if (type === 'users' && route === 'access') result = await access(ctx, id, otherId);
    else throw missing();
  } catch (error) {
    if (error.code === '23505') throw httpError(409, 'conflict', 'Resource already exists');
    if (error.code === '23503') throw missing();
    throw error;
  }
  res.setHeader('Cache-Control', 'no-store');
  send(result[0], result[1]);
  return true;
}
