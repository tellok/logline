// Compile the public Explorer query language to a predicate over log_events AS e.
// User input is always a bound parameter; the compiler never accepts SQL expressions.
const DAY = 86_400_000;
export const fieldTypes = Object.freeze({
  projectId: 'string',
  eventId: 'string',
  service: 'string',
  level: 'string',
  timestamp: 'number',
  message: 'string',
  environment: 'string',
  release: 'string',
  traceId: 'string',
  sessionId: 'string',
  userId: 'string',
});
const columns = {
  projectId: 'e.project_id::text',
  eventId: 'e.event_id',
  service: 'e.service',
  level: 'e.level',
  timestamp: 'e.timestamp_ms',
  message: 'e.message',
};
export function fail(message, status = 400, code = 'invalid_query') {
  throw Object.assign(new Error(message), { status, code });
}
export function object(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const k of Object.keys(value)) if (!keys.includes(k)) fail(`Unknown ${label} property: ${k}`);
  return value;
}
export function integer(n, min, max, label) {
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(`${label} must be an integer between ${min} and ${max}`);
  return n;
}
export function list(value, min, max, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    fail(`${label} must contain ${min} to ${max} entries`);
  return value;
}
export function bind(values, value) {
  values.push(value);
  return `$${values.length}`;
}
export function uuid(value) {
  if (typeof value !== 'string' || !/^\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value))
    fail('Invalid resource ID');
  return value.toLowerCase();
}
export function projectIds(query) {
  if (query?.projectIds === undefined) return undefined;
  return [...new Set(list(query.projectIds, 1, 100, 'projectIds').map(uuid))];
}
function text(value, label, max = 1024) {
  if (typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value) > max || value.includes('\0'))
    fail(`Invalid ${label}`);
  return value;
}
function instant(s) {
  if (
    typeof s !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(s) ||
    !Number.isFinite(Date.parse(s))
  )
    fail('Absolute times require an RFC3339 timestamp with timezone');
  // Date.parse silently rolls nonexistent days (and 24:00) into the next day.
  const [year, month, day] = s.slice(0, 10).split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (
    day < 1 ||
    day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ||
    Number(s.slice(11, 13)) > 23
  )
    fail('Invalid calendar date or hour');
  return Date.parse(s);
}
export function bounds(range = { last: '1h' }, now = Date.now()) {
  object(range, 'range', ['last', 'start', 'end']);
  let start, end;
  if (Object.hasOwn(range, 'last')) {
    if (Object.keys(range).length !== 1) fail('Do not mix relative and absolute bounds');
    const m = /^([1-9]\d{0,5})([mhd])$/.exec(typeof range.last === 'string' ? range.last : '');
    if (!m) fail('Expected a relative window in minutes, hours or days');
    end = now;
    start = end - Number(m[1]) * { m: 60000, h: 3600000, d: DAY }[m[2]];
  } else {
    start = instant(range.start);
    end = instant(range.end);
  }
  if (end <= start || end - start > 30 * DAY) fail('Time window must be positive and at most 30 days');
  return { start, end };
}
export function fieldParts(name) {
  if (typeof name !== 'string') fail('Expected field name');
  if (Object.hasOwn(fieldTypes, name)) return null;
  const path = name.split('.');
  if (
    path.length < 2 ||
    path.length > 5 ||
    !['fields', 'context'].includes(path[0]) ||
    path.slice(1).some((key) => !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key))
  )
    fail('Unknown or invalid field name');
  return path;
}
// Expose projections as JSONB to preserve scalar types and distinguish numeric-looking strings.
export function fieldSql(name, values, type) {
  const path = fieldParts(name);
  let expr;
  if (!path) {
    expr = Object.hasOwn(columns, name) ? columns[name] : `e.context->>'${name}'`;
    if (type && type !== fieldTypes[name]) fail(`Field ${name} is not ${type}`);
    return type ? `(${expr})` : `to_jsonb(${expr})`;
  }
  const root = path[0] === 'fields' ? 'fields' : 'context';
  expr = `(e.${root} #> ${bind(values, path.slice(1))}::text[])`;
  if (!type) return expr;
  const cast = { number: 'numeric', string: 'text', boolean: 'boolean' }[type];
  if (!cast) fail('Unsupported field type');
  return `(CASE WHEN jsonb_typeof(${expr})='${type}' THEN (${expr} #>> '{}')::${cast} END)`;
}
export const operations = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'contains', 'icontains', 'regex'];
// Regex is a deliberately small subset: no backreferences, alternation, groups or counted repeats.
function regex(pattern) {
  text(pattern, 'regex', 128);
  if (!pattern || /[(){}|\\]/.test(pattern) || /[+*?][+*?]/.test(pattern) || /[^\w .,^$*+?\[\]:/@-]/.test(pattern))
    fail('Unsupported regex syntax');
  try {
    new RegExp(pattern, 'u');
  } catch {
    fail('Invalid regex');
  }
  return pattern;
}
export function compileQuery(query = {}, allowedIds, now = Date.now()) {
  object(query, 'query', ['projectIds', 'environments', 'range', 'where']);
  const ids = projectIds(query);
  if (ids?.some((id) => !allowedIds.includes(id))) fail('Project access denied', 403, 'forbidden');
  const { start, end } = bounds(query.range, now);
  const values = [ids ?? allowedIds, start, end];
  const parts = ['e.project_id=ANY($1::uuid[])', 'e.timestamp_ms >= $2::bigint', 'e.timestamp_ms < $3::bigint'];
  if (query.environments !== undefined) {
    const env = list(query.environments, 1, 32, 'environments').map((v) => text(v, 'environment'));
    parts.push(`e.context->>'environment'=ANY(${bind(values, env)}::text[])`);
  }
  let nodes = 0;
  function visit(node, depth) {
    if (++nodes > 40 || depth > 6) fail('Filter tree exceeds budget');
    object(node, 'filter', ['and', 'or', 'not', 'field', 'op', 'value']);
    for (const k of ['and', 'or', 'not']) {
      if (Object.hasOwn(node, k)) {
        if (Object.keys(node).length !== 1) fail('Mixed Boolean and comparison filters');
        if (k === 'not') return `(NOT ${visit(node.not, depth + 1)})`;
        return `(${list(node[k], 1, 16, k)
          .map((x) => visit(x, depth + 1))
          .join(` ${k.toUpperCase()} `)})`;
      }
    }
    const { field, op, value } = node;
    if (!operations.includes(op)) fail('Unknown filter operator');
    const type = typeof value;
    if (!['boolean', 'number', 'string'].includes(type) || (type === 'number' && !Number.isFinite(value)))
      fail('Expected a finite number, string or boolean');
    if (type === 'string') text(value, 'filter value');
    const expr = fieldSql(field, values, type);
    if (['contains', 'icontains', 'regex'].includes(op)) {
      if (field !== 'message' || type !== 'string') fail('Text search requires message and a string');
      const p = bind(values, op === 'regex' ? regex(value) : value);
      return op === 'regex'
        ? `(${expr} ~ ${p})`
        : op === 'contains'
          ? `(strpos(${expr},${p})>0)`
          : `(strpos(lower(${expr}),lower(${p}))>0)`;
    }
    if (type === 'boolean' && !['eq', 'neq'].includes(op)) fail('Boolean values support only equality');
    const operator = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[op];
    return `(${expr} ${operator} ${bind(values, value)}::${{ number: 'numeric', boolean: 'boolean', string: 'text' }[type]})`;
  }
  if (query.where !== undefined) parts.push(visit(query.where, 0));
  return { where: parts.join(' AND '), values, start, end };
}
