import assert from 'node:assert/strict';
import { assertBeta, command, readJson } from './release-contract.mjs';

/** Reject direct publication outside a source-verified beta release job. */
assertBeta(readJson('package.json'));
assert.equal(process.env.npm_config_tag || readJson('package.json').publishConfig.tag, 'beta');
assert.equal(
  process.env.RELEASE_VERIFIED_SHA,
  command('git', ['rev-parse', 'HEAD']).trim(),
  'Publish only from a verified version-PR merge through release.yml',
);
