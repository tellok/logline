import { authorizeUpload } from './auth.mjs';
import { transaction } from './db.mjs';

const levels = new Set(['TRACE', 'DEBUG', 'LOG', 'WARN', 'ERROR']);
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const text = (value, max) =>
  typeof value === 'string' &&
  value.length <= max &&
  value.isWellFormed() &&
  !value.includes('\0') &&
  Buffer.byteLength(value) <= max;
const identity = (value) => text(value, 128) && value.trim().length > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const fault = (status, code, message, extra = {}) =>
  Object.assign(new Error(message), { status, code, ...extra });

// Reject pathological nesting and PostgreSQL-incompatible strings/numbers before batch persistence.
function safeJson(value, depth = 0) {
  if (depth > 24) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return text(value, 65536);
  return typeof value === 'object' && Object.entries(value).every(([k, v]) => text(k, 1024) && safeJson(v, depth + 1));
}

/** Validate envelope-wide identity separately: missing or repeated IDs cannot be acknowledged unambiguously. */
export function envelope(body, maxEvents) {
  if (
    !object(body) ||
    typeof body.projectId !== 'string' ||
    !uuid.test(body.projectId) ||
    Object.keys(body).some((key) => !['projectId', 'events'].includes(key)) ||
    !Array.isArray(body.events) ||
    !body.events.length
  )
    throw fault(400, 'invalid_batch', 'Expected only projectId and a nonempty events array.');
  if (body.events.length > maxEvents) throw fault(413, 'batch_limit', 'Batch event limit exceeded.');
  const ids = new Set();
  for (const e of body.events) {
    if (!object(e) || !identity(e.id) || ids.has(e.id))
      throw fault(400, 'invalid_event_id', 'Every event needs a distinct nonempty ID of at most 128 bytes.');
    ids.add(e.id);
  }
  return body.projectId.toLowerCase();
}

/** Return a result partition for individually identifiable events. Preserve the original record, including optional attributes. */
export function partition(events) {
  const valid = [],
    rejectedEventIds = [];
  for (const e of events) {
    if (
      Object.hasOwn(e, 'ingestKeyId') ||
      !Number.isSafeInteger(e.timestamp) ||
      e.timestamp < 0 ||
      e.timestamp > 253402300799999 ||
      !levels.has(e.level) ||
      !text(e.message, 65536) ||
      (e.fields !== undefined && !object(e.fields)) ||
      (e.context !== undefined &&
        (!object(e.context) ||
          ['traceId', 'sessionId', 'userId', 'environment', 'release'].some(
            (k) => e.context[k] !== undefined && !text(e.context[k], 1024),
          ))) ||
      !safeJson(e)
    ) {
      rejectedEventIds.push(e.id);
      continue;
    }
    const bytes = Buffer.byteLength(JSON.stringify(e));
    if (bytes > 65536) rejectedEventIds.push(e.id);
    else valid.push({ event: e, bytes });
  }
  return { valid, rejectedEventIds };
}

/** Commit new records and shared quota usage together. Identical IDs replay for free; the first committed value wins. */
export async function ingest(db, token, projectId, body, config) {
  return transaction(db, async (client) => {
    const keyId = await authorizeUpload(client, token, projectId);
    const { valid, rejectedEventIds } = partition(body.events);
    const result = { acceptedEventIds: valid.map((v) => v.event.id), retryableEventIds: [], rejectedEventIds };
    if (!valid.length) return { status: 200, body: result, inserted: 0, bytes: 0 };
    await client.query(
      `INSERT INTO log_ingest_quota(project_id,window_start,events,bytes) VALUES ($1,date_trunc('minute',clock_timestamp()),0,0) ON CONFLICT DO NOTHING`,
      [projectId],
    );
    await client.query('SELECT project_id FROM log_ingest_quota WHERE project_id=$1 FOR UPDATE', [projectId]);
    const existing = new Set(
      (
        await client.query('SELECT event_id FROM log_events WHERE project_id=$1 AND event_id=ANY($2::text[])', [
          projectId,
          result.acceptedEventIds,
        ])
      ).rows.map((row) => row.event_id),
    );
    const fresh = valid.filter((v) => !existing.has(v.event.id));
    const bytes = fresh.reduce((n, v) => n + v.bytes, 0);
    if (!fresh.length) return { status: 200, body: result, inserted: 0, bytes: 0 };
    const quota = await client.query(
      `WITH w AS MATERIALIZED (SELECT date_trunc('minute',clock_timestamp()) AS start),
      usage AS (SELECT CASE WHEN q.window_start=w.start THEN q.events ELSE 0 END + $2::bigint AS events,
        CASE WHEN q.window_start=w.start THEN q.bytes ELSE 0 END + $3::bigint AS bytes, w.start
        FROM log_ingest_quota q,w WHERE q.project_id=$1)
      UPDATE log_ingest_quota q SET events=u.events,bytes=u.bytes,window_start=u.start FROM usage u
      WHERE q.project_id=$1 AND u.events <= $4 AND u.bytes <= $5 RETURNING q.events`,
      [projectId, fresh.length, bytes, config.projectEvents, config.projectBytes],
    );
    if (!quota.rowCount) {
      const wait = await client.query(
        "SELECT ceil(extract(epoch FROM date_trunc('minute',clock_timestamp()) + interval '1 minute' - clock_timestamp()) * 1000)::int AS delay",
      );
      const retryAfterMs = Math.max(1, wait.rows[0].delay);
      return {
        status: 429,
        body: {
          acceptedEventIds: [...existing],
          retryableEventIds: fresh.map((v) => v.event.id),
          rejectedEventIds,
          retryAfterMs,
        },
        inserted: 0,
        bytes: 0,
      };
    }
    await client.query(
      `INSERT INTO log_events(project_id,event_id,level,timestamp_ms,message,fields,context,event,ingest_key_id)
      SELECT $1,e->>'id',e->>'level',(e->>'timestamp')::bigint,e->>'message',coalesce(e->'fields','{}'::jsonb),coalesce(e->'context','{}'::jsonb),e,$3 FROM jsonb_array_elements($2::jsonb) e`,
      [projectId, JSON.stringify(fresh.map((v) => v.event)), keyId],
    );
    return { status: 200, body: result, inserted: fresh.length, bytes };
  });
}
