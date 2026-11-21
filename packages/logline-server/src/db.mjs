import { readFile } from 'node:fs/promises';
import pg from 'pg';

/** Isolate query, upload and maintenance connections; bound each checkout and SQL statement. */
export function createPool(connectionString, max, name) {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    query_timeout: 6500,
    keepAlive: true,
    idle_in_transaction_session_timeout: 10000,
    application_name: `logline-${name}`,
  });
  // A primary restart can disconnect a checked-out client between statements. Its next query will reject;
  // the error event must not terminate this process. pg.Pool separately discards failed idle clients.
  pool.on('connect', (client) => client.on('error', () => {}));
  // Never log connection strings or query values.
  pool.on('error', () => process.stderr.write(`logline: idle ${name} database connection lost\n`));
  return pool;
}

/** Roll back on any error, including quota refusal, before returning the connection to its pool. */
export async function transaction(db, run) {
  const client = await db.connect();
  let discard = false;
  try {
    await client.query('BEGIN; SET LOCAL synchronous_commit = on');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

/** Serialize concurrent first startup on the primary. DDL and all schema changes commit together. */
export async function migrate(db) {
  const migrations = await Promise.all(
    ['admin.sql', 'schema.sql', 'explorer.sql'].map((name) => readFile(new URL(name, import.meta.url), 'utf8')),
  );
  await transaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(1819240293, 1)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS logline_schema_versions (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query('SELECT version FROM logline_schema_versions ORDER BY version DESC LIMIT 1');
    if (rows.length) {
      if (rows[0].version !== 1) throw Error('Unsupported database schema version');
      return;
    }
    for (const sql of migrations) await client.query(sql);
    await client.query('INSERT INTO logline_schema_versions (version) VALUES (1)');
  });
}

/** Delete a bounded slice by receipt time; SKIP LOCKED permits cleanup across replicas without blocking. */
export async function prune(db, days) {
  const result = await db.query(
    `DELETE FROM log_events WHERE ctid IN (
    SELECT ctid FROM log_events WHERE received_at < now() - ($1::int * interval '1 day')
    ORDER BY received_at LIMIT 5000 FOR UPDATE SKIP LOCKED)`,
    [days],
  );
  return result.rowCount;
}
