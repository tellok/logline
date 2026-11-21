import assert from 'node:assert/strict';
import { assertBeta, command, readJson } from './release-contract.mjs';

/** Reject direct publication outside a source-verified beta release job. */
for (const name of ['logline', 'logserver-reporter']) {
  const pkg = readJson(`packages/${name}/package.json`);
  assertBeta(pkg);
  assert.equal(process.env.npm_config_tag || pkg.publishConfig.tag, 'beta');
}
assert.equal(
  process.env.RELEASE_VERIFIED_SHA,
  command('git', ['rev-parse', 'HEAD']).trim(),
  'Publish only from a verified version-PR merge through release.yml',
);
