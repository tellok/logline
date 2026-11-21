import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

// Use the public HTTP API for fixtures as well as assertions. The only privileged DB
// operations are test schema isolation and intentionally delaying a query to its budget.
test(
  'Explorer HTTP contracts against PostgreSQL',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 },
  async (t) => {
    const { startServer } = await import('../src/server.mjs');
    const adminToken = randomBytes(32).toString('hex');
    const schema = 'test_explorer_' + randomBytes(8).toString('hex');
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    let app;
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      app = await startServer({
        env: { DATABASE_URL: url.href, LOGLINE_ADMIN_TOKEN: adminToken },
        host: '127.0.0.1',
        port: 0,
      });
      const call = async (token, method, path, body, expected) => {
        const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/v1/${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const payload = response.status === 204 ? undefined : await response.json();
        assert.ok(
          expected ? expected === response.status : response.ok,
          `${method} ${path}: ${response.status} ${response.ok ? '' : JSON.stringify(payload)}`,
        );
        return payload;
      };
      const admin = (method, path, body) => call(adminToken, method, 'admin/' + path, body);
      const person = async (name, scopes) => {
        const { userId } = await admin('POST', 'users', { displayName: name });
        const { secret } = await admin('POST', `users/${userId}/tokens`, { scopes });
        return { userId, secret };
      };
      const actor = await person('Synthetic Reader', ['logs:read']);
      const writer = await person('Synthetic Writer', ['logs:write']);
      const guest = await person('Synthetic Recipient', ['logs:read']);
      const createProject = async (slug) => (await admin('POST', 'projects', { slug, displayName: slug })).projectId;
      const [alpha, beta, hidden] = await Promise.all(['alpha', 'beta', 'hidden'].map(createProject));
      const grant = (id, user, permissions) => admin('PUT', `projects/${id}/members/${user.userId}`, { permissions });
      for (const id of [alpha, beta, hidden]) await grant(id, writer, ['logs:write']);
      for (const id of [alpha, beta]) await grant(id, actor, ['logs:read']);
      await grant(alpha, guest, ['logs:read']);
      const http = (method, path, body, status, token = actor.secret) =>
        call(token, method, 'explorer/' + path, body, status);
      const post = (path, body, status) => http('POST', path, body, status);
      const time = Math.floor((Date.now() - 120000) / 60000) * 60000;
      const entry = (id, n, message, extra = {}) => ({
        id,
        timestamp: time,
        level: 'WARN',
        message,
        fields: { duration: n },
        context: { environment: 'sample', traceId: 'trace-1', sessionId: 'session-1' },
        ...extra,
      });
      const upload = async (projectId, events) => {
        const ack = await call(writer.secret, 'POST', 'logs', { projectId, service: 'synthetic-service', events });
        assert.deepEqual(
          ack.acceptedEventIds,
          events.map((e) => e.id),
        );
      };
      await upload(alpha, [
        entry('a1', 10, 'Timeout ONE'),
        entry('a2', 5, 'timeout TWO', { timestamp: time + 60000 }),
        entry('a3', '100', 'timeout text, not numeric'),
      ]);
      await upload(beta, [entry('b1', 7, 'TIMEOUT three'), entry('b2', 13, 'unrelated')]);
      await upload(hidden, [
        entry('a1', 999, 'inaccessible', { fields: { privateOnly: 999 }, context: { environment: 'hidden' } }),
      ]);
      const all = { projectIds: [alpha, beta], range: { last: '1h' } };
      const query = {
        ...all,
        environments: ['sample'],
        where: {
          and: [
            { field: 'message', op: 'icontains', value: 'timeout' },
            { field: 'fields.duration', op: 'gte', value: 5 },
          ],
        },
      };
      const projected = ['projectId', 'eventId', 'fields.duration'];

      await t.test('discovery, typed searches, tied timestamp pagination and context honor scope', async () => {
        const projects = await http('GET', 'projects');
        assert.deepEqual(new Set(projects.items.map((p) => p.projectId)), new Set([alpha, beta]));
        const selectors = await post('selectors', {});
        assert.deepEqual(new Set(selectors.items.map((p) => p.environment)), new Set(['sample']));
        const fields = await post('fields', {});
        assert.equal(
          fields.items.some((f) => f.name === 'fields.privateOnly'),
          false,
        );
        const duration = fields.items.find((f) => f.name === 'fields.duration');
        assert.deepEqual(duration.types, ['number', 'string']);
        assert.ok(duration.operators.includes('gte'));
        const shape = { query, columns: projected, sort: 'asc', limit: 1 };
        const page1 = await post('rows', shape);
        assert.equal(page1.limited, true);
        const page2 = await post('rows', { ...shape, cursor: page1.nextCursor });
        const page3 = await post('rows', { ...shape, cursor: page2.nextCursor });
        assert.equal(page3.nextCursor, null);
        const rows = [...page1.items, ...page2.items, ...page3.items];
        assert.deepEqual(new Set(rows.map((r) => r.eventId)), new Set(['a1', 'a2', 'b1']));
        assert.equal(rows.at(-1).eventId, 'a2');
        for (const row of rows) assert.deepEqual(Object.keys(row).sort(), [...projected].sort());
        await post('rows', { ...shape, sort: 'desc', cursor: page1.nextCursor }, 409);
        const narrow = {
          ...query,
          range: { start: new Date(time).toISOString(), end: new Date(time + 60000).toISOString() },
        };
        assert.equal((await post('rows', { query: narrow })).items.length, 2);
        const target = { projectId: alpha, eventId: 'a1' };
        assert.equal((await post('detail', target)).item.message, 'Timeout ONE');
        for (const mode of ['trace', 'session', 'nearby']) {
          const context = await post('context', { ...target, mode, limit: 1 });
          assert.equal(context.limited, true);
          assert.equal(context.items[0].projectId, alpha);
          assert.notEqual(context.items[0].eventId, 'a1');
        }
        const empty = await post('rows', { query: { where: { field: 'message', op: 'eq', value: 'no matches' } } });
        assert.deepEqual(empty.items, []);
        assert.equal(empty.limited, false);
        await post('rows', { query: { where: { field: 'message', op: 'regex', value: '(unsafe)+' } } }, 400);
      });

      await t.test('shared filters drive chart buckets, groups, and byte- and row-bounded exports', async () => {
        const spec = { query, groupBy: ['level'], metric: { op: 'sum', field: 'fields.duration' } };
        const groups = await post('groups', spec);
        assert.deepEqual(groups.items, [{ group: ['WARN'], value: 22 }]);
        assert.deepEqual((await post('series', { ...spec, intervalSeconds: 60 })).items, [
          { bucket: time, group: ['WARN'], value: 17 },
          { bucket: time + 60000, group: ['WARN'], value: 5 },
        ]);
        assert.equal(
          (await post('groups', { ...spec, metric: { op: 'avg', field: 'fields.duration' } })).items[0].value,
          22 / 3,
        );
        const csv = await post('export', {
          query,
          format: 'csv',
          columns: ['eventId', 'message'],
          sort: 'asc',
          limit: 2,
        });
        assert.equal(csv.rowCount, 2);
        assert.equal(csv.limitReason, 'rows');
        assert.match(csv.data, /^"eventId","message"\r?\n/);
        const jsonl = await post('export', { ...spec, mode: 'groups', format: 'jsonl' });
        assert.deepEqual(JSON.parse(jsonl.data), { level: 'WARN', value: 22 });
        const bytes = await post('export', { query, format: 'jsonl', byteLimit: 8 });
        assert.equal(bytes.limitReason, 'bytes');
        assert.equal(bytes.rowCount, 0);
        assert.equal(bytes.byteCount, 0);
      });

      await t.test('refresh resumes a bounded page and picks up late-arriving events without replay', async () => {
        const shape = {
          // Match only this scenario: an older cluster-wide transaction can hold the
          // initial frontier behind fixtures that were already visible to /rows.
          query: { ...all, where: { field: 'message', op: 'contains', value: 'late ' } },
          limit: 1,
          columns: ['eventId', 'timestamp'],
        };
        const first = await post('refresh', shape);
        assert.equal(first.initialized, true);
        let cursor = first.nextCursor;
        const older = await pool.connect();
        try {
          await older.query('BEGIN');
          await older.query('SELECT pg_current_xact_id()');
          await upload(alpha, [
            entry('late-a', 1, 'late A', { timestamp: time - 90000 }),
            entry('late-b', 1, 'late B', { timestamp: time - 95000 }),
          ]);
          await upload(hidden, [entry('late-private', 1, 'late private')]);
          const pending = await post('refresh', { ...shape, cursor });
          assert.equal(pending.pendingTransactions, true);
          assert.deepEqual(pending.items, []);
          cursor = pending.nextCursor;
        } finally {
          await older.query('ROLLBACK');
          older.release();
        }
        // xmin is cluster-wide: unrelated test schemas may also have open transactions.
        let second = await post('refresh', { ...shape, cursor });
        const deadline = Date.now() + 10000;
        while (!second.items.length && second.pendingTransactions && Date.now() < deadline) {
          await delay(25);
          second = await post('refresh', { ...shape, cursor: second.nextCursor });
        }
        assert.equal(second.limited, true);
        const third = await post('refresh', { ...shape, cursor: second.nextCursor });
        assert.deepEqual(
          new Set([...second.identities, ...third.identities].map((r) => `${r.projectId}/${r.eventId}`)),
          new Set([`${alpha}/late-a`, `${alpha}/late-b`]),
        );
        const fourth = await post('refresh', { ...shape, cursor: third.nextCursor });
        assert.deepEqual(fourth.items, []);
        assert.equal(fourth.limited, false);
      });

      await t.test('saved links are versioned, preserve stable scope on rename and never convey access', async () => {
        const definition = {
          schemaVersion: 1,
          query,
          columns: projected,
          sort: 'asc',
          visualization: { mode: 'series', style: 'line', groupBy: ['level'], intervalSeconds: 60 },
        };
        const saved = await post('views', { name: 'Synthetic chart', visibility: 'link', definition }, 201);
        const path = `views/${saved.item.viewId}`;
        assert.deepEqual((await http('GET', path)).item.definition, definition);
        assert.equal((await http('GET', 'views')).items.length, 1);
        await http('GET', path, undefined, 404, guest.secret);
        await grant(beta, guest, ['logs:read']);
        assert.deepEqual((await http('GET', path, undefined, 200, guest.secret)).item.definition, definition);
        const updated = await http('PATCH', path, { version: saved.item.version, name: 'Renamed chart' });
        assert.equal(updated.item.version, 2);
        await http('PATCH', path, { version: 1, name: 'Stale update' }, 409);
        await admin('PATCH', `projects/${beta}`, { slug: 'renamed_beta', displayName: 'Renamed Beta' });
        assert.deepEqual((await http('GET', path)).item.definition, definition);
        assert.equal((await post('rows', { query })).items.length, 3);
        await admin('DELETE', `projects/${beta}/members/${actor.userId}`);
        const denied = { query: { projectIds: [beta] } };
        for (const action of ['selectors', 'fields', 'rows', 'groups', 'series', 'refresh'])
          await post(action, denied, 403);
        await post('export', { ...denied, format: 'jsonl' }, 403);
        await post('detail', { projectId: beta, eventId: 'b1' }, 403);
        await post('context', { projectId: beta, eventId: 'b1' }, 403);
        assert.deepEqual((await http('GET', 'views')).items, []);
        await http('GET', path, undefined, 404);
        assert.deepEqual(new Set((await post('rows', {})).items.map((r) => r.projectId)), new Set([alpha]));
        await grant(beta, actor, ['logs:read']);
        await http('DELETE', path);
        await http('GET', path, undefined, 404);
      });

      await t.test('query budget exhaustion is retryable, not an empty or truncated result', async () => {
        const lock = await pool.connect();
        try {
          await lock.query('BEGIN');
          await lock.query(`LOCK TABLE ${schema}.log_events IN ACCESS EXCLUSIVE MODE`);
          const failure = await post('rows', { query }, 503);
          assert.match(JSON.stringify(failure), /query_budget/);
        } finally {
          await lock.query('ROLLBACK');
          lock.release();
        }
        assert.equal((await post('rows', { query })).items.length, 3);
      });
    } finally {
      await app?.close();
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    }
  },
);
