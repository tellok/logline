import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

/** Check all public build entries so package exports never point to missing files. */
for (const path of [
  '.',
  './auto-import',
  './html-interop',
  './vite-plugin',
  './plugin/indexeddb',
  './plugin/click-log',
]) {
  const pattern = path.startsWith('./plugin/') ? './plugin/*' : path;
  const entry = pkg.exports[pattern];
  const plugin = path.split('/').at(-1);
  for (const file of Object.values(entry)) {
    assert.ok(existsSync(new URL(file.replace('*', plugin), root)), file);
  }
  const id = path === '.' ? 'logline' : `logline/${path.slice(2)}`;
  await import(id);
  require(id);
}

const runtime = await import('logline');
assert.equal(runtime.LOGLINE_MODULE_ID, 'logline');
assert.equal(typeof runtime.configureLogline, 'function');
assert.equal(runtime.createLoglineAutoImport().resolvers[0]('LOG').from, 'logline');
