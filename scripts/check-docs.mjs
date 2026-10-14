import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './release-contract.mjs';

/** Verify both rendered languages, project asset paths, and the exact documentation source identity. */
const output = join(root, '.vitepress/dist');
for (const page of ['index.html', 'zh/index.html', 'docs/indexeddb.html', 'zh/docs/indexeddb.html']) {
  const html = readFileSync(join(output, page), 'utf8');
  assert.match(html, /Logline/);
  assert.match(html, /\/logline\/assets\//, 'Documentation assets must use the project Pages base');
}
const metadata = JSON.parse(readFileSync(join(output, 'release.json'), 'utf8'));
assert.equal(metadata.version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
assert.equal(metadata.sourceSha, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
process.stdout.write('Verified bilingual documentation, project asset paths, version, and source SHA.\n');
