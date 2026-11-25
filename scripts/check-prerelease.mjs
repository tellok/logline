import assert from 'node:assert/strict';
import { command, packageVersion, PUBLIC_PACKAGES } from './release-contract.mjs';

/** Reject direct publication outside a source-verified beta release job. */
for (const name of PUBLIC_PACKAGES) packageVersion(name);
assert.equal(process.env.npm_config_tag || 'beta', 'beta');
assert.equal(
  process.env.RELEASE_VERIFIED_SHA,
  command('git', ['rev-parse', 'HEAD']).trim(),
  'Publish only from a verified version-PR merge through release.yml',
);
