import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertBeta, newestV1, pendingChangesets, prepareFiles, releaseChapter } from './release-contract.mjs';

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

test('workspace version preparation versions only the public library without building it', () => {
  const folder = mkdtempSync(join(tmpdir(), 'logline-workspace-version-'));
  const writeJson = (path, value) => writeFileSync(join(folder, path), JSON.stringify(value));
  try {
    for (const path of ['.changeset', '.release', 'packages/logline'])
      mkdirSync(join(folder, path), { recursive: true });
    writeJson('package.json', {
      name: 'synthetic-workspace',
      private: true,
      devDependencies: { '@changesets/cli': '2.29.7' },
    });
    writeFileSync(join(folder, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    writeJson('packages/logline/package.json', {
      name: 'logline',
      version: '2.0.0-beta.0',
      publishConfig: { tag: 'beta' },
      scripts: { build: 'node -e "process.exit(99)"' },
    });
    writeJson('.changeset/config.json', { baseBranch: 'master', access: 'public' });
    writeJson('.changeset/pre.json', {
      mode: 'pre',
      tag: 'beta',
      initialVersions: { logline: '1.1.5' },
      changesets: [],
    });
    writeJson('.changeset/translations.json', { 'synthetic-update': 'Synthetic translated release summary.' });
    writeFileSync(join(folder, '.changeset/synthetic-update.md'), '---\nlogline: patch\n---\n\nSynthetic update.\n');
    for (const name of ['CHANGELOG.md', 'CHANGELOG.zh-CN.md'])
      writeFileSync(join(folder, 'packages/logline', name), '# Logline\n\n## 2.0.0-beta.0\n\nSynthetic baseline.\n');
    const plan = prepareFiles(folder, 'synthetic-source');
    assert.equal(plan.package, 'logline');
    assert.equal(plan.version, '2.0.0-beta.1');
    assert.equal(JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8')).version, undefined);
    assert.equal(existsSync(join(folder, 'packages/logline/dist')), false);
    assert.equal(existsSync(join(folder, 'CHANGELOG.md')), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
