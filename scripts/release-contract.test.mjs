import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertBeta, newestV1, pendingChangesets, releaseChapter } from './release-contract.mjs';

test('beta contract rejects latest, stable versions, and alpha versions', () => {
  assert.doesNotThrow(() => assertBeta({ version: '2.0.0-beta.0', publishConfig: { tag: 'beta' } }));
  for (const pkg of [
    { version: '2.0.0', publishConfig: { tag: 'beta' } },
    { version: '2.0.0-alpha.0', publishConfig: { tag: 'beta' } },
    { version: '2.0.0-beta.0', publishConfig: { tag: 'latest' } },
  ])
    assert.throws(() => assertBeta(pkg));
});
test('latest uses the newest v1 minor and patch, excluding prereleases and v2', () => {
  assert.equal(newestV1(['1.0.0', '1.9.9', '1.10.2', '1.10.3-beta.0', '2.0.0-beta.0']), '1.10.2');
});
test('release notes reject missing and duplicate chapters and exclude old versions', () => {
  const notes = '## 2.0.0-beta.0\n\nCurrent changes\n\n## 1.1.4\n\nOld changes\n';
  assert.equal(releaseChapter(notes, '2.0.0-beta.0'), '## 2.0.0-beta.0\n\nCurrent changes');
  assert.throws(() => releaseChapter(notes, '2.0.0-beta.1'));
  assert.throws(() => releaseChapter(notes + '## 2.0.0-beta.0\nAgain', '2.0.0-beta.0'));
});
test('pending detection excludes README, hidden files, metadata, and consumed prerelease changesets', () => {
  const folder = mkdtempSync(join(tmpdir(), 'logline-pending-'));
  try {
    mkdirSync(join(folder, '.changeset'));
    for (const name of ['README.md', '.hidden.md', 'consumed.md', 'pending.md'])
      writeFileSync(join(folder, '.changeset', name), 'example');
    writeFileSync(join(folder, '.changeset/pre.json'), JSON.stringify({ mode: 'pre', changesets: ['consumed'] }));
    assert.deepEqual(pendingChangesets(folder), ['pending.md']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
