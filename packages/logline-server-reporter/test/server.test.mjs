import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { configureLogline, ERROR, resetLoglineConfig } from 'logline';
import { createLoglineServerReporter } from 'logline-server-reporter';

// A consumer of the built packages, not a test of an injected mock transport.
test(
  'reports via project DSN independently of members; PATs only read and revoked keys stop uploading',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { startServer } = await import('../../logline-server/src/server.mjs');
    const { createPool } = await import('../../logline-server/src/db.mjs');
    const db = createPool(process.env.TEST_DATABASE_URL, 1, 'integration');
    const schema = 'test_uploader_' + randomBytes(12).toString('hex');
    const url = new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options', `-csearch_path=${schema}`);
    let app, reporter;
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      const adminToken = randomBytes(32).toString('hex');
      app = await startServer({
        host: '127.0.0.1',
        port: 0,
        env: { DATABASE_URL: url.href, LOGLINE_ADMIN_TOKEN: adminToken },
      });
      const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
      async function api(path, method, token, payload, expected) {
        const res = await fetch(`${baseUrl}/api/v1/${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: payload === undefined ? undefined : JSON.stringify(payload),
        });
        assert.ok([expected].flat().includes(res.status), `${method} ${path}: unexpected HTTP ${res.status}`);
        return res.status === 204 ? undefined : res.json();
      }
      const admin = (path, method, payload, status) => api('admin/' + path, method, adminToken, payload, status);
      const { projectId } = await admin('projects', 'POST', { slug: 'sample', displayName: 'Sample' }, 201);
      const { userId } = await admin('users', 'POST', { displayName: 'Test reader' }, 201);
      await admin(`projects/${projectId}/members/${userId}`, 'PUT', { permissions: ['logs:read'] }, 204);
      const { secret: reader } = await admin(`users/${userId}/tokens`, 'POST', { scopes: ['logs:read'] }, 201);
      const { keyId, key } = await admin(`projects/${projectId}/keys`, 'POST', { name: 'checkout' }, 201);
      const dsn = new URL(baseUrl);
      dsn.username = key;
      dsn.pathname = `/${projectId}`;
      reporter = createLoglineServerReporter({
        dsn: dsn.href,
        reporting: { context: { environment: 'staging' } },
      });
      configureLogline({ plugins: [reporter] });
      ERROR('Checkout failed', { password: 'synthetic-private-value' });
      const result = await reporter.flush({ timeout: 5000 });
      assert.equal(result.accepted, 1, JSON.stringify(result));
      const query = { query: { projectIds: [projectId] } };
      const { items } = await api('explorer/rows', 'POST', reader, query, 200);
      assert.equal(items.length, 1);
      assert.match(items[0].message, /Checkout failed/);
      assert.equal(items[0].id, items[0].eventId);
      assert.equal(items[0].context.environment, 'staging');
      assert.equal(items[0].level, 'ERROR');
      assert.doesNotMatch(JSON.stringify(items), /synthetic-private-value/);
      await api('explorer/rows', 'POST', key, query, [401, 403]);
      const batch = { projectId, events: [{ id: 'read-only', timestamp: 0, level: 'LOG', message: 'not accepted' }] };
      await api('logs', 'POST', reader, batch, [401, 403]);
      await admin(`projects/${projectId}/members/${userId}`, 'DELETE', undefined, 204);
      await api('explorer/rows', 'POST', reader, query, 403);
      ERROR('Project keys outlive membership');
      assert.equal((await reporter.flush({ timeout: 5000 })).accepted, 1);
      await admin(`projects/${projectId}/keys/${keyId}`, 'DELETE', undefined, 204);
      ERROR('Revoked keys cannot upload');
      assert.equal((await reporter.flush({ timeout: 5000 })).rejected, 1);
    } finally {
      reporter?.dispose();
      resetLoglineConfig();
      await app?.close();
      try {
        await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await db.end();
      }
    }
  },
);
