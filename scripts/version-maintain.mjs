import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { command, prepareFiles, root } from './release-contract.mjs';

/**
 * Invoked by the changesets-version-pr component as its `version-command`. The component has
 * already verified a clean, trusted default-branch checkout; this script versions the tree in
 * place (no build, no publish) and writes the proposed release notes body that the component
 * reads back after this step. It must not call `gh` or read release secrets: the component
 * runs it under a stripped environment without a token.
 */
const baseSha = command('git', ['rev-parse', 'HEAD']).trim();
const plan = prepareFiles(root, baseSha);
const changed = plan.packages.filter((item) => item.version !== item.previousVersion);
assert.ok(changed.length, 'No package version advanced');

const body = [
  '## Proposed beta release',
  '',
  'Not published yet. Merging this version PR authorizes its verified beta release.',
  '',
  '### Packages',
  '',
  ...plan.packages.map(
    (item) =>
      `- \`${item.name}\`: ${item.version === item.previousVersion ? 'unchanged' : `${item.previousVersion} -> ${item.version}`}`,
  ),
  '',
  '### Changes',
  '',
  ...plan.changesets.map((item) => `- ${item.summary}`),
  '',
  '### Simplified Chinese',
  '',
  ...plan.changesets.map((item) => `- ${item.translation}`),
  '',
].join('\n');

writeFileSync(resolve(root, '.release/version-pr-body.md'), `${body}\n`);
process.stdout.write(`Prepared ${changed.map((item) => `${item.name}@${item.version}`).join(', ')} from ${baseSha}.\n`);
