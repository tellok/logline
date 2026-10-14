import { describe, expect, test } from 'vitest';
import { DEFAULT_DB_NAME, normalizeViteBasePath, resolveIndexedDBDatabaseName } from './database-name';

describe('IndexedDB database name resolution', () => {
  test('explicit databaseName takes precedence and stays unchanged', () => {
    expect(resolveIndexedDBDatabaseName('manual-logs', '/branch-a/', '/branch-b/')).toBe('manual-logs');
    expect(resolveIndexedDBDatabaseName('', '/branch-a/', '/branch-b/')).toBe('');
  });

  test('prefers the base injected by the Vite plugin', () => {
    expect(resolveIndexedDBDatabaseName(undefined, '/branch-a/', '/branch-b/')).toBe('logline:/branch-a');
  });

  test('falls back to runtime Vite base for unresolved dynamic placeholders', () => {
    expect(resolveIndexedDBDatabaseName(undefined, '/__dynamic_base__/', '/branches/feature-a/')).toBe(
      'logline:/branches/feature-a',
    );
  });

  test('uses the default name for root paths and invalid bases', () => {
    expect(resolveIndexedDBDatabaseName(undefined, '/', '/branch-b/')).toBe(DEFAULT_DB_NAME);
    expect(resolveIndexedDBDatabaseName(undefined, '/__dynamic_base__/', undefined)).toBe(DEFAULT_DB_NAME);
  });

  test('normalizes absolute URLs, repeated slashes, and trailing slashes', () => {
    expect(normalizeViteBasePath('https://cdn.example.test//branches/feature-a/?v=1#hash')).toBe('/branches/feature-a');
    expect(normalizeViteBasePath('relative-base/')).toBe('/relative-base');
  });
});
