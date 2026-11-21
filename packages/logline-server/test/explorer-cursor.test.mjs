import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import pg from 'pg';
import { migrate } from '../src/db.mjs';
import { refresh } from '../src/explorer-query.mjs';

// Cursor integrity and expiry are independent of an external clock or running database.
test('poll cursors are signed, expire and cannot be reused under a different scope', async () => {
  const ids = [randomUUID()];
  const state = {
    ids,
    action: 'refresh',
    userId: randomUUID(),
    now: Date.now(),
    key: randomUUID(),
    db: { query: async () => ({ rows: [{ high: '123', pendingTransactions: false }] }) },
  };
  const { nextCursor: cursor } = await refresh(state, {});
  await assert.rejects(refresh({ ...state, now: state.now + 15 * 60000 + 1 }, { cursor }), {
    status: 410,
    code: 'cursor_expired',
  });
  await assert.rejects(refresh({ ...state, ids: [] }, { cursor }), { status: 409, code: 'cursor_mismatch' });
  await assert.rejects(refresh({ ...state, userId: randomUUID() }, { cursor }), {
    status: 409,
    code: 'cursor_mismatch',
  });
  await assert.rejects(refresh({ ...state, key: randomUUID() }, { cursor }), { status: 400 });
});

test(
  'resumed polls on another connection see both events after inverted upload commit order',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 20000 },
  async () => {
    const schema = 'test_poll_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    const reader = new pg.Pool({ connectionString: url.href });
    const replica = new pg.Pool({ connectionString: url.href });
    let held;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(reader);
      const ps = await reader.query(
        "INSERT INTO projects(slug,display_name) VALUES ('one','One'),('two','Two') RETURNING project_id",
      );
      const ids = ps.rows.map((r) => r.project_id);
      const userId = randomUUID();
      const poll = (db, cursor) =>
        refresh(
          { db, action: 'refresh', userId, ids, now: Date.now() },
          { query: { projectIds: ids }, columns: ['eventId'], limit: 1, cursor },
        );
      const start = await poll(reader);
      held = await reader.connect();
      await held.query('BEGIN');
      const insert = `INSERT INTO log_events(project_id,event_id,service,level,timestamp_ms,message,fields,context,event) VALUES ($1,$2,'demo','LOG',$3,'demo','{}','{}','{}')`;
      const t = Date.now() - 1000;
      await held.query(insert, [ids[0], 'allocated-first', t]);
      await replica.query(insert, [ids[1], 'committed-first', t]);
      const delayed = await poll(replica, start.nextCursor);
      assert.deepEqual(delayed.items, []);
      assert.equal(delayed.pendingTransactions, true);
      await held.query('COMMIT');
      held.release();
      held = null;
      // Other suites may pin this database's global transaction watermark while CI runs in parallel.
      const seen = [];
      let page = delayed;
      const deadline = Date.now() + 12000;
      while (seen.length < 2 && Date.now() < deadline) {
        page = await poll(seen.length ? reader : replica, page.nextCursor);
        seen.push(...page.items.map((r) => r.eventId));
        if (!page.items.length) await delay(25);
      }
      assert.deepEqual(seen, ['allocated-first', 'committed-first']);
      assert.deepEqual((await poll(reader, page.nextCursor)).items, []);
    } finally {
      if (held) {
        try {
          await held.query('ROLLBACK');
        } finally {
          held.release();
        }
      }
      await Promise.all([reader.end(), replica.end()]);
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  },
);
