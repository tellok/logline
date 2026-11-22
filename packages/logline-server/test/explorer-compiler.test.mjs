import assert from 'node:assert/strict';
import test from 'node:test';
import { bounds, compileQuery, fieldSql } from '../src/explorer-compiler.mjs';
const allowed = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const now = Date.parse('2024-03-01T08:00:00Z');
const compile = (query) => compileQuery(query, [allowed], now);
const leaf = (field, op, value) => ({ field, op, value });

test('every filter is nested below immutable project and half-open time predicates', () => {
  const pattern = "synthetic' value";
  const q = compile({
    projectIds: [allowed],
    environments: ['demo'],
    where: {
      or: [
        leaf('message', 'contains', pattern),
        { and: [{ not: leaf('level', 'eq', 'DEBUG') }, leaf('fields.feature.enabled', 'eq', true)] },
      ],
    },
  });
  assert.match(
    q.where,
    /^e.project_id=ANY\(\$1::uuid\[\]\) AND e.timestamp_ms >= \$2::bigint AND e.timestamp_ms < \$3::bigint AND/,
  );
  assert.deepEqual(q.values, [[allowed], now - 3600000, now, ['demo'], pattern, 'DEBUG', ['feature', 'enabled'], true]);
  assert.ok(!q.where.includes(pattern));
  assert.ok(!q.where.includes('feature'));
  assert.ok(q.where.includes(' OR '));
  assert.ok(q.where.includes('NOT '));
  assert.throws(() => compile({ projectIds: [allowed, other] }), { status: 403, code: 'forbidden' });
  assert.deepEqual(compileQuery({}, []).values[0], []);
});

test('time bounds require explicit zones, valid dates, exclusive end and bounded positive windows', () => {
  assert.deepEqual(bounds({ start: '2024-02-29T00:00:00-08:00', end: '2024-03-01T08:00:00Z' }), {
    start: now - 86400000,
    end: now,
  });
  for (const range of [
    { last: '0m' },
    { last: '31d' },
    { last: 'tomorrow' },
    { start: '2024-02-29', end: '2024-03-01' },
    { last: '1h', start: '2024-02-29' },
    { start: '2023-02-29T00:00:00Z', end: '2023-03-02T00:00:00Z' },
    { start: '2024-02-29T24:00:00Z', end: '2024-03-02T00:00:00Z' },
    { start: '2024-02-29T00:00:00Z', end: '2024-02-29T00:00:00Z' },
  ])
    assert.throws(() => bounds(range), { status: 400 });
  assert.deepEqual(bounds({ last: '30d' }, now), { start: now - 30 * 86400000, end: now });
});

test('scalar comparisons never coerce strings to numbers; paths and values are parameters', () => {
  const vs = [];
  assert.equal(fieldSql('fields.amount', vs), '(e.fields #> $1::text[])');
  assert.deepEqual(vs, [['amount']]);
  assert.match(compile({ where: leaf('fields.n', 'gt', 7) }).where, /jsonb_typeof\(.+\)='number'.+::numeric END/);
  for (const where of [
    leaf('timestamp', 'eq', '7'),
    leaf('fields.n', 'gt', true),
    leaf('fields.name', 'contains', 'n'),
    leaf('fields.n', 'eq', NaN),
    leaf('message', 'eq', '\u0000'),
    leaf('message', 'eq', '\ud800'),
    leaf('__proto__', 'eq', 'x'),
    leaf('constructor', 'eq', 'x'),
    leaf('fields.x;', 'eq', true),
    leaf('fields.a.b.c.d.e', 'eq', true),
  ])
    assert.throws(() => compile({ where }), { status: 400, code: 'invalid_query' });
});

test('tag equality compiles to GIN-servable containment; other tag operators extract values', () => {
  const q = compile({
    where: { and: [leaf('tags.app', 'eq', 'shop'), leaf('tags.app', 'neq', 'mall'), leaf('tags.tier', 'gt', 'a')] },
  });
  // Key and value are bound parameters; the containment shape matches the jsonb_path_ops GIN index.
  assert.match(q.where, /e\.tags @> jsonb_build_object\(\$4::text, to_jsonb\(\$5::text\)\)/);
  assert.match(q.where, /\(e\.tags #> \$6::text\[\]\)/);
  assert.deepEqual(q.values.slice(3), ['app', 'shop', ['app'], 'mall', ['tier'], 'a']);
  for (const where of [
    leaf('tags.app.deep', 'eq', 'x'),
    leaf('tags', 'eq', 'x'),
    leaf('tags.1bad', 'eq', 'x'),
    leaf('tags.app', 'contains', 'x'),
  ])
    assert.throws(() => compile({ where }), { status: 400, code: 'invalid_query' });
});

test('Boolean depth, breadth, total nodes, unknown keys and regex syntax are bounded', () => {
  const f = leaf('message', 'icontains', 'example');
  let deep = f;
  for (let i = 0; i < 7; i++) deep = { not: deep };
  for (const where of [
    deep,
    { or: Array(17).fill(f) },
    { and: Array(16).fill({ or: [f, f, f] }) },
    { or: [] },
    { not: f, field: 'level' },
    { sql: 'SELECT 1' },
    ...['(a+)+', 'a|b', 'a{99}', '[', 'a\\1', 'a'.repeat(129)].map((p) => leaf('message', 'regex', p)),
  ])
    assert.throws(() => compile({ where }), { status: 400 });
  const q = compile({ where: leaf('message', 'regex', '^Error [0-9]+$') });
  assert.match(q.where, / ~ \$4/);
  assert.equal(q.values[3], '^Error [0-9]+$');
  for (const query of [
    { projectIds: [] },
    { projectIds: [null] },
    { environments: Array(33).fill('a') },
    { unrecognized: true },
  ])
    assert.throws(() => compile(query), { status: 400 });
});
