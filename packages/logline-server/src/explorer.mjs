import { authorize } from './auth.mjs';
import { fail, integer, object, projectIds, uuid } from './explorer-compiler.mjs';
import { aggregates, columns, detail, metadata, projects, refresh, rows } from './explorer-query.mjs';
import { views } from './explorer-views.mjs';

function csv(value) {
  let str = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  if (typeof value === 'string' && /^(?:\s*[=+@-]|[\t\r\n])/.test(str)) str = "'" + str;
  return '"' + str.replaceAll('"', '""') + '"';
}
// Exports return bounded UTF-8 text inside JSON so limits are visible before a UI offers a download.
async function exportRows(s, b) {
  object(b, 'export', ['mode', 'format', 'limit', 'byteLimit', 'columns', 'query', 'sort', 'groupBy', 'metric']);
  const { mode = 'rows', format, query, sort, groupBy, metric } = b;
  const limit = integer(b.limit ?? 100, 1, 1000, 'limit');
  const byteLimit = integer(b.byteLimit ?? 262144, 1, 1048576, 'byteLimit');
  if (!['rows', 'groups'].includes(mode) || !['csv', 'jsonl'].includes(format)) fail('Invalid export mode or format');
  if ((mode === 'groups' && sort !== undefined) || (mode === 'rows' && (groupBy !== undefined || metric !== undefined)))
    fail('Inapplicable export options');
  let names = b.columns;
  if (mode === 'groups') {
    const possible = [...(Array.isArray(groupBy) ? groupBy : []), 'value'];
    names ??= possible;
    if (
      !Array.isArray(names) ||
      !names.length ||
      names.length > 4 ||
      new Set(names).size !== names.length ||
      names.some((n) => !possible.includes(n))
    )
      fail('Invalid aggregate columns');
  } else {
    if (format === 'csv') names ??= ['projectId', 'eventId', 'timestamp', 'level', 'message'];
    columns(names);
  }
  let data = '',
    byteCount = 0,
    rowCount = 0,
    limitReason = null,
    cursor;
  function add(line) {
    const size = Buffer.byteLength(line);
    if (size + byteCount > byteLimit) {
      limitReason = 'bytes';
      return false;
    }
    data += line;
    byteCount += size;
    return true;
  }
  if (format === 'csv') add(names.map(csv).join(',') + '\r\n');
  let range;
  do {
    if (Date.now() - s.now > 3000) fail('Export budget exhausted; retry a narrower query', 503, 'query_budget');
    const n = Math.min(25, limit - rowCount);
    let page;
    if (mode === 'groups') {
      page = await aggregates(s, { query, groupBy, metric, limit }, false, 1000);
      page.items = page.items.map((r) =>
        Object.fromEntries(names.map((k) => [k, k === 'value' ? r.value : r.group[groupBy.indexOf(k)]])),
      );
    } else {
      page = await rows(s, { query, columns: names, sort, cursor, limit: n });
    }
    range = page.range;
    if (limitReason) break;
    for (const r of page.items) {
      if (!add(format === 'csv' ? names.map((n) => csv(r[n])).join(',') + '\r\n' : JSON.stringify(r) + '\n')) break;
      rowCount++;
    }
    if (limitReason) break;
    if (mode === 'groups' && page.limited) limitReason = page.limitReason;
    else if (rowCount === limit && page.limited) limitReason = 'rows';
    cursor = page.nextCursor;
  } while (cursor && !limitReason);
  return { format, data, byteCount, rowCount, limited: limitReason !== null, limitReason, range };
}

const actions = [
  'projects',
  'selectors',
  'fields',
  'rows',
  'groups',
  'series',
  'detail',
  'context',
  'refresh',
  'export',
  'views',
];
/** Execute one authorized operation against a fresh database snapshot. Callers pass the raw PAT, never trusted grants. */
export async function runExplorer({ db, token, action, body = {}, id, method = 'POST' }) {
  if (!actions.includes(action)) fail('Unknown Explorer operation', 404, 'not_found');
  const client = await db.connect();
  let discard = false;
  try {
    await client.query(
      `BEGIN ISOLATION LEVEL REPEATABLE READ ${action === 'views' && method !== 'GET' ? 'READ WRITE' : 'READ ONLY'}`,
    );
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    let selected;
    if (['detail', 'context'].includes(action)) selected = [uuid(body?.projectId)];
    else if (action !== 'views') selected = projectIds(body?.query);
    const auth = await authorize(client, token, 'logs:read', selected);
    const s = {
      db: client,
      userId: auth.userId,
      projects: auth.projects,
      ids: auth.projects.map((p) => p.projectId),
      now: Date.now(),
      action,
    };
    let result;
    switch (action) {
      case 'projects':
        result = projects(s, body);
        break;
      case 'fields':
      case 'selectors':
        result = await metadata(s, body, action === 'fields');
        break;
      case 'detail':
      case 'context':
        result = await detail(s, body, action === 'context');
        break;
      case 'groups':
      case 'series':
        result = await aggregates(s, body, action === 'series');
        break;
      case 'rows':
        result = await rows(s, body);
        break;
      case 'refresh':
        result = await refresh(s, body);
        break;
      case 'export':
        result = await exportRows(s, body);
        break;
      case 'views':
        result = await views(s, body, id, method);
        break;
    }
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    if (err.code === '2201B') fail('Invalid message regex');
    if (['57014', '40001', '55P03'].includes(err.code))
      fail('Database query budget or transaction conflict; retry', 503, 'query_budget');
    throw err;
  } finally {
    client.release(discard);
  }
}

/** Return false for unrelated paths; server owns authentication header parsing, request limits and error serialization. */
export async function handleExplorer({ req, url, db, token, body }) {
  const prefix = '/api/v1/explorer';
  if (!url.pathname.startsWith(prefix + '/')) return false;
  const [action, id, ...rest] = url.pathname.slice(prefix.length + 1).split('/');
  if (!actions.includes(action) || rest.length || (action !== 'views' && id !== undefined) || id === '')
    fail('Not found', 404, 'not_found');
  const method = req.method;
  if (
    action === 'projects'
      ? method !== 'GET'
      : action === 'views'
        ? !(id ? ['GET', 'PATCH', 'DELETE'] : ['GET', 'POST']).includes(method)
        : method !== 'POST'
  )
    fail('Method not allowed', 405, 'method_not_allowed');
  if (method === 'GET') {
    body = {};
    for (const [key, value] of url.searchParams) {
      if (!['limit', 'offset'].includes(key) || Object.hasOwn(body, key) || !/^\d{1,5}$/.test(value))
        fail('Invalid pagination query');
      body[key] = Number(value);
    }
  }
  const result = await runExplorer({ db, token, action, body: body ?? {}, id, method });
  return {
    status: action === 'views' && method === 'POST' ? 201 : 200,
    body: result,
    headers: { 'cache-control': 'no-store' },
  };
}
