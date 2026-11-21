import { compileQuery, fail, integer, object, projectIds, uuid } from './explorer-compiler.mjs';
import { aggregationShape, columns } from './explorer-query.mjs';
const returning = `view_id AS "viewId",owner_id AS "ownerId",name,version,visibility,definition`;
// Every access checks both ownership/visibility and that all explicit projects remain readable.
export async function views(s, b, id, method) {
  if (id) id = uuid(id);
  if (method === 'GET' && !id) {
    object(b, 'views', ['offset', 'limit']);
    const offset = integer(b.offset ?? 0, 0, 10000, 'offset');
    const limit = integer(b.limit ?? 50, 1, 100, 'limit');
    const { rows } = await s.db.query(
      `SELECT ${returning} FROM explorer_views WHERE owner_id=$1 AND project_ids <@ $2::uuid[] ORDER BY view_id LIMIT $3 OFFSET $4`,
      [s.userId, s.ids, limit + 1, offset],
    );
    return {
      items: rows.slice(0, limit),
      limited: rows.length > limit,
      nextOffset: rows.length > limit && offset + limit <= 10000 ? offset + limit : null,
    };
  }
  let old;
  if (id) {
    const { rows } = await s.db.query(
      `SELECT ${returning} FROM explorer_views WHERE view_id=$1 AND (owner_id=$2 ${method === 'GET' ? "OR visibility='link'" : ''}) AND project_ids <@ $3::uuid[]`,
      [id, s.userId, s.ids],
    );
    if (!rows.length) fail('View not found', 404, 'not_found');
    old = rows[0];
  }
  if (method === 'GET') {
    object(b, 'view', []);
    return { item: old };
  }
  if (method === 'DELETE') {
    object(b, 'view', []);
    await s.db.query('DELETE FROM explorer_views WHERE view_id=$1 AND owner_id=$2', [id, s.userId]);
    return { deleted: true };
  }
  object(b, 'view', ['name', 'definition', 'visibility', ...(id ? ['version'] : [])]);
  if (id && b.version !== old.version) fail('View was modified; reload before editing', 409, 'version_conflict');
  const name = b.name ?? old?.name;
  const def = b.definition ?? old?.definition;
  const visibility = b.visibility ?? old?.visibility ?? 'private';
  if (
    typeof name !== 'string' ||
    !name.isWellFormed() ||
    !name.trim() ||
    Buffer.byteLength(name) > 256 ||
    name.includes('\0')
  )
    fail('View name must be 1 to 256 bytes');
  if (!['link', 'private'].includes(visibility)) fail('Unknown visibility');
  object(def, 'definition', ['schemaVersion', 'query', 'sort', 'columns', 'visualization']);
  if (def.schemaVersion !== 1) fail('Expected definition schemaVersion 1');
  const q = compileQuery(def.query ?? {}, s.ids, s.now);
  if (def.sort !== undefined && !['asc', 'desc'].includes(def.sort)) fail('Invalid sort');
  columns(def.columns);
  if (def.visualization !== undefined) {
    object(def.visualization, 'visualization', ['mode', 'style', 'groupBy', 'intervalSeconds', 'metric']);
    const { mode, style } = def.visualization;
    if (!['rows', 'groups', 'series'].includes(mode)) fail('Unknown visualization mode');
    if (style !== undefined && !['bar', 'line', 'area'].includes(style)) fail('Unknown chart style');
    aggregationShape(def.visualization, q);
  }
  const ids = projectIds(def.query) ?? [];
  if (visibility === 'link' && !ids.length) fail('Link visibility requires explicit projectIds');
  if (Buffer.byteLength(JSON.stringify(def)) > 16_384) fail('View definition exceeds 16 KiB');
  const vals = [s.userId, name, visibility, ids, JSON.stringify(def)];
  let result;
  if (!id) {
    result = await s.db.query(
      `INSERT INTO explorer_views(owner_id,name,visibility,project_ids,definition) VALUES ($1,$2,$3,$4,$5) RETURNING ${returning}`,
      vals,
    );
  } else {
    result = await s.db.query(
      `UPDATE explorer_views SET name=$2,visibility=$3,project_ids=$4,definition=$5,version=version+1 WHERE owner_id=$1 AND view_id=$6 AND version=$7 RETURNING ${returning}`,
      [...vals, id, old.version],
    );
    if (!result.rowCount) fail('View was modified; reload before editing', 409, 'version_conflict');
  }
  return { item: result.rows[0] };
}
