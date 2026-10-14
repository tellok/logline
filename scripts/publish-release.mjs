import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  api,
  assertBeta,
  command,
  newestV1,
  project,
  readJson,
  releaseChapter,
  root,
  waitForPublishedIntegrity,
} from './release-contract.mjs';

const pkg = readJson('package.json');
assertBeta(pkg);
const sourceSha = command('git', ['rev-parse', 'HEAD']).trim();
assert.equal(process.env.RELEASE_VERIFIED_SHA, sourceSha, 'Release source was not verified');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Publish using the trusted GitHub release workflow');
const { repository } = project();
const folder = mkdtempSync(join(tmpdir(), 'logline-delivery-'));
const registry = '--registry=https://registry.npmjs.org/';

/** Preserve latest on the newest stable v1 subversion before and after beta delivery. */
const assertLatest = () => {
  const published = JSON.parse(command('npm', ['view', pkg.name, 'versions', '--json', registry]));
  const tags = JSON.parse(command('npm', ['view', pkg.name, 'dist-tags', '--json', registry]));
  assert.equal(tags.latest, newestV1(published), 'latest must select the newest published stable v1');
  return tags;
};
assertLatest();
const packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', folder]));
assert.equal(packed.length, 1);
const tarball = join(folder, packed[0].filename);
const bytes = readFileSync(tarball);
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const remote = spawnSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'dist.integrity', '--json', registry], {
  cwd: root,
  encoding: 'utf8',
});
if (remote.status === 0)
  assert.equal(JSON.parse(remote.stdout), integrity, 'An existing npm version has different content');
else {
  assert.match(remote.stderr, /E404/, 'Registry failure is not proof that a version is unpublished');
  command('npm', [
    'publish',
    tarball,
    '--ignore-scripts',
    '--tag',
    'beta',
    '--access',
    'public',
    '--provenance',
    registry,
  ]);
}
await waitForPublishedIntegrity(
  () =>
    spawnSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'dist.integrity', '--json', registry], {
      cwd: root,
      encoding: 'utf8',
    }),
  integrity,
);
assert.equal(assertLatest().beta, pkg.version, 'beta dist-tag does not identify the delivered version');
const manifest = {
  package: pkg.name,
  version: pkg.version,
  sourceSha,
  channel: 'beta',
  integrity,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const manifestFile = join(folder, 'release-manifest.json');
writeFileSync(manifestFile, `${JSON.stringify(manifest, undefined, 2)}\n`);
const notesFile = join(folder, 'release-notes.md');
writeFileSync(
  notesFile,
  `${releaseChapter(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), pkg.version)}\n\n### Simplified Chinese\n\n${releaseChapter(readFileSync(join(root, 'CHANGELOG.zh-CN.md'), 'utf8'), pkg.version)}\n`,
);
const tag = `v${pkg.version}`;
const refs = api(`repos/${repository}/git/matching-refs/tags/${tag}`);
const existingTag = refs.find((ref) => ref.ref === `refs/tags/${tag}`);
if (existingTag) assert.equal(existingTag.object.sha, sourceSha, 'Release tag already points to another source');
const releases = api(`repos/${repository}/releases?per_page=100`, { paginate: true });
const existing = releases.find((release) => release.tag_name === tag);
if (!existing)
  command('gh', [
    'release',
    'create',
    tag,
    '--repo',
    repository,
    '--target',
    sourceSha,
    '--prerelease',
    '--latest=false',
    '--title',
    `${pkg.name} ${pkg.version}`,
    '--notes-file',
    notesFile,
    tarball,
    manifestFile,
  ]);
else {
  assert.ok(existing.prerelease && !existing.draft);
  for (const file of [tarball, manifestFile]) {
    assert.ok(existsSync(file));
    const name = file.split('/').at(-1);
    const asset = existing.assets.find((entry) => entry.name === name);
    if (asset)
      assert.equal(
        asset.digest,
        `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`,
        'Existing release asset content differs',
      );
    else command('gh', ['release', 'upload', tag, file, '--repo', repository]);
  }
}
process.stdout.write(`Published ${pkg.name}@${pkg.version} with beta; latest remains on the newest v1.\n`);
