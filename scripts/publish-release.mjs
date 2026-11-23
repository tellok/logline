import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import {
  assertBeta,
  command,
  newestV1,
  output,
  packageTag,
  project,
  readJson,
  releaseChapter,
  root,
} from './release-contract.mjs';

const plan = readJson('.release/version-plan.json');
assert.equal(plan.schema, 3);
assert.equal(plan.channel, 'beta');
const sourceSha = command('git', ['rev-parse', 'HEAD']).trim();
assert.equal(process.env.RELEASE_VERIFIED_SHA, sourceSha, 'Release source was not verified');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Publish using the trusted GitHub release workflow');
project(); // Resolve the repository identity before the first authenticated write.
const folder = mkdtempSync(join(tmpdir(), 'logline-delivery-'));
const registry = '--registry=https://registry.npmjs.org/';
const KEYS = { logline: 'core', 'logline-server-reporter': 'reporter' };

/** Preserve latest on the newest stable v1 subversion for the established `logline` package. */
const assertLatest = () => {
  const published = JSON.parse(command('npm', ['view', 'logline', 'versions', '--json', registry]));
  const tags = JSON.parse(command('npm', ['view', 'logline', 'dist-tags', '--json', registry]));
  assert.equal(tags.latest, newestV1(published), 'latest must select the newest published stable v1');
  return tags;
};
assertLatest();

/**
 * Publish one tarball. Prefer trusted publishing (OIDC); when that is not configured, fall back
 * to an optional granular access token in `NPM_TOKEN`. `--provenance` still records SLSA
 * attestations in both cases, because provenance uses the workflow's `id-token`, not the npm token.
 */
function publishTarball(tarball, manifest) {
  const args = [
    'publish',
    tarball,
    '--ignore-scripts',
    '--tag',
    'beta',
    '--access',
    'public',
    '--provenance',
    registry,
  ];
  const run = (env) => spawnSync('npm', args, { cwd: root, encoding: 'utf8', env });
  const fail = (result) => {
    process.stderr.write(result.stderr || '');
    throw new Error(`npm publish failed for ${manifest.name}@${manifest.version}`);
  };

  // Try OIDC first so an expired 90-day token never masks a working trusted publisher.
  const token = process.env.NPM_TOKEN;
  const oidcEnv = { ...process.env };
  delete oidcEnv.NODE_AUTH_TOKEN;
  delete oidcEnv.NPM_TOKEN;
  const oidc = run({ ...oidcEnv, NPM_CONFIG_USERCONFIG: devNull });
  if (oidc.status === 0) {
    process.stdout.write(`Published ${manifest.name} using npm Trusted Publishing.\n`);
    return;
  }
  const diagnostic = oidc.stderr || '';
  const authFailure =
    /E401|E403|ENEEDAUTH|401 Unauthorized|403 Forbidden|auth required|requires you to be logged in|unable to authenticate/i.test(
      diagnostic,
    ) || diagnostic.includes(`404 Not Found - PUT https://registry.npmjs.org/${manifest.name} -`);
  if (!token || !authFailure) fail(oidc);
  process.stdout.write(`Retrying ${manifest.name} with the configured npm access token.\n`);
  const fallback = run({ ...oidcEnv, NODE_AUTH_TOKEN: token });
  if (fallback.status !== 0) fail(fallback);
}

/** Pack and publish one package's tarball; recovery must reproduce identical bytes. */
async function deliver(manifest) {
  assertBeta(manifest);
  const tarball = join(folder, `${manifest.name}-${manifest.version}.tgz`);
  command('pnpm', ['--config.ignore-scripts=true', 'pack', '--out', tarball], join(root, 'packages', manifest.name));
  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const readIntegrity = () =>
    spawnSync('npm', ['view', `${manifest.name}@${manifest.version}`, 'dist.integrity', '--json', registry], {
      cwd: root,
      encoding: 'utf8',
    });
  let remote = readIntegrity();
  if (remote.status !== 0) {
    assert.match(remote.stderr, /E404/, 'Registry failure is not proof that a version is unpublished');
    publishTarball(tarball, manifest);
    const deadline = Date.now() + 10 * 60 * 1000;
    remote = readIntegrity();
    while (remote.status !== 0 && /E404/.test(remote.stderr) && Date.now() < deadline) {
      process.stdout.write(`Waiting for ${manifest.name}@${manifest.version} to appear in the npm registry.\n`);
      await setTimeout(10000);
      remote = readIntegrity();
    }
  }
  assert.equal(remote.status, 0, `Could not verify npm publication: ${remote.stderr}`);
  assert.equal(JSON.parse(remote.stdout), integrity, 'The published npm version has different content');
  assert.equal(
    JSON.parse(command('npm', ['view', manifest.name, 'dist-tags', '--json', registry])).beta,
    manifest.version,
  );
  return { tarball, integrity, sha256: createHash('sha256').update(bytes).digest('hex') };
}

const delivered = [];
for (const item of plan.packages.filter((pkg) => pkg.version !== pkg.previousVersion)) {
  assert.equal(item.deliver, 'npm');
  const manifest = readJson(`packages/${item.name}/package.json`);
  const result = await deliver(manifest);

  // Per-package release notes come only from that package's exact changelog chapter.
  const notes = [
    `## ${item.name}`,
    '',
    releaseChapter(readFileSync(join(root, `packages/${item.name}/CHANGELOG.md`), 'utf8'), item.version),
    '',
    '### Simplified Chinese',
    '',
    releaseChapter(readFileSync(join(root, `packages/${item.name}/CHANGELOG.zh-CN.md`), 'utf8'), item.version),
    '',
  ].join('\n');
  const notesFile = join(folder, `${item.name}-notes.md`);
  writeFileSync(notesFile, notes);

  const manifestFile = join(folder, `${item.name}-manifest.json`);
  writeFileSync(
    manifestFile,
    `${JSON.stringify(
      {
        package: item.name,
        version: item.version,
        sourceSha,
        channel: 'beta',
        integrity: result.integrity,
        sha256: result.sha256,
      },
      undefined,
      2,
    )}\n`,
  );

  // The github-release component creates the immutable tag and uploads/verifies these assets.
  const assetsFile = join(folder, `${item.name}-assets.json`);
  writeFileSync(
    assetsFile,
    `${JSON.stringify(
      [
        { name: `${item.name}-${item.version}.tgz`, path: result.tarball, hash: `sha256:${result.sha256}` },
        {
          name: `${item.name}-manifest.json`,
          path: manifestFile,
          hash: `sha256:${createHash('sha256').update(readFileSync(manifestFile)).digest('hex')}`,
        },
      ],
      undefined,
      2,
    )}\n`,
  );

  const key = KEYS[item.name];
  assert.ok(key, `Unexpected package ${item.name}`);
  output(`${key}_tag`, packageTag(item.name, item.version));
  output(`${key}_name`, `${item.name} ${item.version}`);
  output(`${key}_notes`, notesFile);
  output(`${key}_assets`, assetsFile);
  delivered.push(item.name);
}
assert.ok(delivered.length, 'No package advanced in this version plan');
if (delivered.includes('logline')) {
  const loglineVersion = plan.packages.find((pkg) => pkg.name === 'logline').version;
  assert.equal(assertLatest().beta, loglineVersion, 'beta dist-tag does not identify the delivered logline version');
}
process.stdout.write(`Published ${delivered.join(', ')} at beta; logline latest remains on the newest v1.\n`);
