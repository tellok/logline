import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  bind,
  compileQuery,
  fail,
  fieldParts,
  fieldSql,
  fieldTypes,
  integer,
  list,
  object,
  operations,
  uuid,
} from './explorer-compiler.mjs';

const TTL = 15 * 60_000;
function canonical(v) {
  return Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
}
// Cursors are tied to the token's owner, current authorized scope, action and query.
function fingerprint(s, b) {
  const shape = Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'cursor' && k !== 'limit'));
  return createHash('sha256')
    .update(JSON.stringify(canonical([s.userId, [...s.ids].sort(), s.action, shape])))
    .digest('hex');
}
async function key(s) {
  if (!s.key) s.key = (await s.db.query('SELECT secret FROM explorer_keys WHERE singleton')).rows[0].secret;
  return s.key;
}
async function encode(s, b, p) {
  const payload = Buffer.from(JSON.stringify({ ...p, exp: s.now + TTL, fp: fingerprint(s, b) })).toString('base64url');
  return (
    payload +
    '.' +
    createHmac('sha256', await key(s))
      .update(payload)
      .digest('base64url')
  );
}
async function decode(s, b) {
  if (b.cursor === undefined) return null;
  if (typeof b.cursor !== 'string' || b.cursor.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(b.cursor))
    fail('Invalid cursor');
  const [payload, mac, ...extra] = b.cursor.split('.');
  const expected = createHmac('sha256', await key(s))
    .update(payload)
    .digest('base64url');
  if (
    extra.length ||
    mac?.length !== expected.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(mac, 'ascii'))
  )
    fail('Invalid cursor');
  let p;
  try {
    p = JSON.parse(Buffer.from(payload, 'base64url'));
  } catch {
    fail('Invalid cursor');
  }
  if (p.exp < s.now) fail('Cursor expired; restart the query', 410, 'cursor_expired');
  if (p.fp !== fingerprint(s, b)) fail('Query or scope changed; restart the query', 409, 'cursor_mismatch');
  return p;
}
export function columns(names) {
  if (names === undefined) return undefined;
  list(names, 1, 24, 'columns').forEach(fieldParts);
  if (new Set(names).size !== names.length) fail('Duplicate column');
  // Overlapping parent/child paths duplicate nested values and increase response size.
  if (names.some((name) => names.some((parent) => name.startsWith(parent + '.')))) fail('Overlapping projected paths');
  return names;
}
function projection(names, values) {
  if (!columns(names))
    return `(e.event || jsonb_build_object('projectId',e.project_id,'eventId',e.event_id,'ingestKeyId',e.ingest_key_id,'timestamp',e.timestamp_ms,'message',e.message))`;
  return `jsonb_build_object(${names.map((n) => `${bind(values, n)}::text, ${fieldSql(n, values)}`).join(',')})`;
}
function scopeQuery(s, b, now = s.now) {
  return compileQuery(b.query ?? {}, s.ids, now);
}
function frame(q) {
  return { start: new Date(q.start).toISOString(), end: new Date(q.end).toISOString() };
}
function direction(sort = 'desc') {
  if (!['asc', 'desc'].includes(sort)) fail('sort must be asc or desc');
  return sort;
}
export function aggregationShape(b, q) {
  const groupBy = b.groupBy ?? [];
  list(groupBy, 0, 3, 'groupBy').forEach(fieldParts);
  if (new Set(groupBy).size !== groupBy.length) fail('Duplicate group');
  const metric = b.metric ?? { op: 'count' };
  object(metric, 'metric', ['op', 'field']);
  if (!['sum', 'avg', 'count'].includes(metric.op)) fail('Invalid metric operation');
  if (metric.op === 'count') {
    if (Object.hasOwn(metric, 'field')) fail('count does not take a field');
  } else {
    fieldSql(metric.field, [], 'number');
  }
  let intervalSeconds = b.intervalSeconds;
  if (intervalSeconds !== undefined) {
    integer(intervalSeconds, 1, 2592000, 'intervalSeconds');
    if (
      q &&
      Math.floor((q.end - 1) / (intervalSeconds * 1000)) - Math.floor(q.start / (intervalSeconds * 1000)) + 1 > 1000
    )
      fail('Series exceeds 1000 time buckets');
  }
  return { groupBy, metric, intervalSeconds };
}
export async function rows(s, b, max = 100) {
  object(b, 'rows', ['query', 'columns', 'sort', 'limit', 'cursor']);
  const limit = integer(b.limit ?? 50, 1, max, 'limit');
  const sort = direction(b.sort);
  const p = await decode(s, b);
  const now = p?.now ?? s.now;
  const q = scopeQuery(s, b, now);
  const v = q.values;
  const after = p
    ? ` AND (e.timestamp_ms,e.project_id,e.event_id) ${sort === 'asc' ? '>' : '<'} (${bind(v, p.t)}::bigint,${bind(v, p.p)}::uuid,${bind(v, p.i)}::text)`
    : '';
  const { rows: rs } = await s.db.query(
    `SELECT ${projection(b.columns, v)} AS item,e.timestamp_ms AS t,e.project_id AS p,e.event_id AS i FROM log_events e WHERE ${q.where}${after} ORDER BY e.timestamp_ms ${sort},e.project_id ${sort},e.event_id ${sort} LIMIT ${bind(v, limit + 1)}`,
    v,
  );
  const limited = rs.length > limit;
  if (limited) rs.pop();
  const last = rs.at(-1);
  return {
    items: rs.map((r) => r.item),
    identities: rs.map((r) => ({ projectId: r.p, eventId: r.i })),
    range: frame(q),
    limited,
    nextCursor: limited ? await encode(s, b, { now, t: last.t, p: last.p, i: last.i }) : null,
  };
}
export async function aggregates(s, b, isSeries, max = 500) {
  object(b, 'aggregation', ['query', 'groupBy', 'metric', ...(isSeries ? ['intervalSeconds'] : []), 'limit']);
  const q = scopeQuery(s, b);
  const v = q.values;
  const limit = integer(b.limit ?? 100, 1, max, 'limit');
  const g = aggregationShape(
    {
      ...b,
      intervalSeconds: isSeries ? (b.intervalSeconds ?? Math.max(1, Math.ceil((q.end - q.start) / 60_000))) : undefined,
    },
    q,
  );
  const groups = g.groupBy.map((f) => fieldSql(f, v));
  const interval = g.intervalSeconds * 1000;
  const dims = [
    ...(isSeries
      ? [`floor(e.timestamp_ms::numeric/${bind(v, interval)}::bigint)::bigint*${bind(v, interval)}::bigint AS bucket`]
      : []),
    ...(groups.length ? [`jsonb_build_array(${groups.join(',')}) AS grp`] : []),
  ];
  const metric = g.metric.op === 'count' ? 'count(*)' : `${g.metric.op}(${fieldSql(g.metric.field, v, 'number')})`;
  const positions = dims.map((_, i) => i + 1).join(',');
  const order = `${isSeries ? 'bucket ASC,' : ''} value DESC NULLS LAST ${groups.length ? ',grp ASC' : ''}`;
  // A few high-cardinality grouping values may themselves be large JSON objects. Bound the
  // result on the database side before pg decodes it, including for synchronous exports.
  const { rows: candidates } = await s.db.query(
    `WITH top_groups AS (SELECT ${[...dims, `${metric} AS value`].join(',')} FROM log_events e WHERE ${q.where} ${positions ? 'GROUP BY ' + positions : ''} ORDER BY ${order} LIMIT ${bind(v, limit + 1)}),
     sized AS (SELECT *, row_number() OVER ordered AS rn,
       sum(64 + ${groups.length ? 'octet_length(grp::text)' : '0'}) OVER ordered AS bytes FROM top_groups
       WINDOW ordered AS (ORDER BY ${order} ROWS UNBOUNDED PRECEDING))
     SELECT ${isSeries ? 'bucket,' : ''} ${groups.length ? 'CASE WHEN bytes<=1048576 THEN grp END AS grp,' : ''}
       value, bytes>1048576 AS overflow FROM sized ORDER BY rn`,
    v,
  );
  const rs = candidates.filter((r) => !r.overflow).slice(0, limit);
  const limited = rs.length < candidates.length;
  const limitReason = limited ? (candidates[rs.length]?.overflow ? 'bytes' : 'rows') : null;
  return {
    items: rs.map((r) => ({
      ...(isSeries && { bucket: Number(r.bucket) }),
      group: r.grp ?? [],
      value: r.value === null ? null : Number(r.value),
    })),
    range: frame(q),
    limited,
    sampled: false,
    limitReason,
  };
}
function offsetPage(b, max = 100) {
  return { offset: integer(b.offset ?? 0, 0, 10000, 'offset'), limit: integer(b.limit ?? 50, 1, max, 'limit') };
}
function page(rs, offset, limit) {
  const limited = rs.length > limit;
  return { items: rs.slice(0, limit), limited, nextOffset: limited && offset + limit <= 10000 ? offset + limit : null };
}
export function projects(s, b) {
  object(b, 'projects', ['offset', 'limit']);
  const { offset, limit } = offsetPage(b);
  return page(
    [...s.projects].sort((a, b) => a.projectId.localeCompare(b.projectId)).slice(offset, offset + limit + 1),
    offset,
    limit,
  );
}
export async function metadata(s, b, fields) {
  object(b, 'metadata', ['query', 'offset', 'limit']);
  const { offset, limit } = offsetPage(b);
  const q = scopeQuery(s, b);
  const v = q.values;
  if (!fields) {
    const { rows: rs } = await s.db.query(
      `SELECT DISTINCT e.project_id AS "projectId",e.context->>'environment' AS environment FROM log_events e WHERE ${q.where} ORDER BY 1,2 LIMIT ${bind(v, limit + 1)} OFFSET ${bind(v, offset)}`,
      v,
    );
    return { ...page(rs, offset, limit), range: frame(q) };
  }
  const { rows: rs } = await s.db.query(
    `SELECT e.fields,e.context FROM log_events e WHERE ${q.where} ORDER BY e.timestamp_ms DESC,e.project_id,e.event_id LIMIT 201`,
    v,
  );
  const names = new Map(Object.entries(fieldTypes).map(([name, type]) => [name, new Set([type])]));
  let incomplete = rs.length > 200;
  function collect(key, value, depth) {
    if (typeof value !== 'object' || !value || Array.isArray(value) || depth > 4) return;
    for (const [n, v] of Object.entries(value)) {
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(n)) continue;
      const name = key + '.' + n;
      if (!names.has(name)) {
        if (names.size >= 512) {
          incomplete = true;
          continue;
        }
        names.set(name, new Set());
      }
      names.get(name).add(v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
      collect(name, v, depth + 1);
    }
  }
  for (const r of rs.slice(0, 200)) {
    collect('fields', r.fields, 1);
    collect('context', r.context, 1);
  }
  const items = [...names]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, types]) => ({
      name,
      types: [...types].sort(),
      operators: operations.filter(
        (op) =>
          name === 'message' ||
          (['eq', 'neq'].includes(op)
            ? [...types].some((t) => ['string', 'number', 'boolean'].includes(t))
            : ['lt', 'lte', 'gt', 'gte'].includes(op) && [...types].some((t) => ['number', 'string'].includes(t))),
      ),
    }));
  return { ...page(items.slice(offset, offset + limit + 1), offset, limit), sampled: incomplete, range: frame(q) };
}
export async function detail(s, b, context) {
  object(b, 'lookup', ['projectId', 'eventId', ...(context ? ['mode', 'limit'] : [])]);
  const id = uuid(b.projectId);
  if (typeof b.eventId !== 'string' || !b.eventId || Buffer.byteLength(b.eventId) > 128 || b.eventId.includes('\0'))
    fail('Invalid eventId');
  if (!s.ids.includes(id)) fail('Project access denied', 403, 'forbidden');
  const { rows: rs } = await s.db.query(
    `SELECT ${projection(undefined, [])} AS item,e.timestamp_ms AS t,e.context FROM log_events e WHERE e.project_id=$1 AND e.event_id=$2`,
    [id, b.eventId],
  );
  if (!rs.length) fail('Event not found', 404, 'not_found');
  if (!context) return { item: rs[0].item };
  const limit = integer(b.limit ?? 25, 1, 100, 'limit');
  const mode = b.mode ?? 'nearby';
  if (!['nearby', 'trace', 'session'].includes(mode)) fail('Invalid context mode');
  const key = mode === 'trace' ? 'traceId' : 'sessionId';
  const match = rs[0].context?.[key];
  if (mode !== 'nearby' && !match) return { items: [], limited: false };
  const radius = mode === 'nearby' ? 300000 : 86400000;
  const v = [id, Number(rs[0].t) - radius, Number(rs[0].t) + radius, b.eventId, rs[0].t, limit + 1];
  const { rows: neighbors } = await s.db.query(
    `SELECT ${projection(undefined, [])} AS item FROM log_events e WHERE e.project_id=$1 AND e.timestamp_ms BETWEEN $2 AND $3 AND e.event_id<>$4 ${mode === 'nearby' ? '' : `AND e.context ? '${key}' AND e.context->>'${key}'=${bind(v, match)}`} ORDER BY abs(e.timestamp_ms-$5::bigint),e.timestamp_ms,e.event_id LIMIT $6`,
    v,
  );
  return { items: neighbors.slice(0, limit).map((r) => r.item), limited: neighbors.length > limit };
}
// A safe cutoff cannot be a bare BIGSERIAL: later sequence allocations may commit first.
// xmin is older than every still-open transaction. Only drain transactions below that frontier.
export async function refresh(s, b) {
  object(b, 'refresh', ['query', 'columns', 'limit', 'cursor']);
  const limit = integer(b.limit ?? 50, 1, 100, 'limit');
  const p = await decode(s, b);
  if (b.query?.range && !Object.hasOwn(b.query.range, 'last')) fail('Refresh requires a relative time window');
  const q = scopeQuery(s, b, p?.window ?? s.now);
  const v = q.values;
  const proj = projection(b.columns, v);
  const frontier = p?.high
    ? { high: p.high, pendingTransactions: p.pending }
    : (
        await s.db.query(`WITH snapshot AS (SELECT pg_current_snapshot() AS s)
    SELECT pg_snapshot_xmin(s)::text AS high, pg_snapshot_xmin(s)<pg_snapshot_xmax(s) AS "pendingTransactions" FROM snapshot`)
      ).rows[0];
  const high = frontier.high;
  // True means committed uploads may still be behind a transaction that has not finished.
  const status = { asOf: new Date(q.end).toISOString(), pendingTransactions: frontier.pendingTransactions };
  if (!p)
    return {
      items: [],
      identities: [],
      limited: false,
      initialized: true,
      ...status,
      nextCursor: await encode(s, b, { low: high }),
      range: frame(q),
    };
  const extra = p.x ? ` AND (e.ingest_xid,e.ingest_seq)>(${bind(v, p.x)}::xid8,${bind(v, p.seq)}::bigint)` : '';
  const { rows: rs } = await s.db.query(
    `SELECT ${proj} AS item,e.project_id AS p,e.event_id AS i,e.ingest_xid::text AS x,e.ingest_seq AS seq FROM log_events e WHERE ${q.where} AND e.ingest_xid >= ${bind(v, p.low)}::xid8 AND e.ingest_xid < ${bind(v, high)}::xid8 ${extra} ORDER BY e.ingest_xid,e.ingest_seq LIMIT ${bind(v, limit + 1)}`,
    v,
  );
  const limited = rs.length > limit;
  if (limited) rs.pop();
  const last = rs.at(-1);
  return {
    items: rs.map((r) => r.item),
    identities: rs.map((r) => ({ projectId: r.p, eventId: r.i })),
    limited,
    initialized: false,
    ...status,
    range: frame(q),
    nextCursor: await encode(
      s,
      b,
      limited
        ? { low: p.low, high, pending: frontier.pendingTransactions, window: q.end, x: last.x, seq: last.seq }
        : { low: high },
    ),
  };
}
