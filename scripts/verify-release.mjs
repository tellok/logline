import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  command,
  output,
  prepareFiles,
  project,
  readJson,
  OWNERSHIP_MARKER,
  PUBLIC_PACKAGES,
  VERSION_BRANCH,
  VERSION_FILES,
} from './release-contract.mjs';

const { repository, defaultBranch } = project();
const sha = command('git', ['rev-parse', 'HEAD']).trim();
const associated = api(`repos/${repository}/commits/${sha}/pulls?per_page=100`, { paginate: true });
const candidates = associated.filter(
  (pr) =>
    pr.merged_at &&
    pr.merge_commit_sha === sha &&
    pr.base.ref === defaultBranch &&
    pr.head.ref === VERSION_BRANCH &&
    pr.head.repo?.full_name === repository &&
    pr.labels.some((label) => label.name === 'release:version') &&
    pr.body?.includes(OWNERSHIP_MARKER),
);
if (!candidates.length) {
  output('eligible', false);
  process.exit(0);
}
assert.equal(candidates.length, 1);
const pr = api(`repos/${repository}/pulls/${candidates[0].number}`);
const parents = command('git', ['show', '-s', '--format=%P']).trim().split(' ');
assert.equal(parents.length, 2, 'Version PRs must use merge commits');
assert.equal(parents[1], pr.head.sha);
const plan = readJson('.release/version-plan.json');
assert.equal(plan.baseSha, parents[0], 'Version plan is stale relative to its actual merge base');
assert.equal(plan.channel, 'beta');
assert.equal(plan.cli, '2.29.7');
assert.equal(plan.schema, 3);
assert.deepEqual(
  plan.packages.map((item) => item.name),
  PUBLIC_PACKAGES,
  'Version plan packages differ from the public deliverable set',
);
const changed = command('git', ['diff', '--name-only', plan.baseSha, pr.head.sha]).trim().split('\n');
assert.ok(
  changed.every((path) => VERSION_FILES.includes(path)),
  'Version PR contains non-version changes',
);
const folder = mkdtempSync(join(tmpdir(), 'logline-release-proof-'));
try {
  command('git', ['worktree', 'add', '--detach', folder, plan.baseSha]);
  const expected = prepareFiles(folder, plan.baseSha);
  assert.deepEqual(expected, plan, 'Changeset consumption or source provenance mismatch');
  for (const file of VERSION_FILES)
    assert.equal(
      command('git', ['show', `${pr.head.sha}:${file}`]),
      readFileSync(join(folder, file), 'utf8'),
      `Version preparation differs: ${file}`,
    );
} finally {
  command('git', ['worktree', 'remove', '--force', folder]);
  rmSync(folder, { recursive: true, force: true });
}
command('git', ['fetch', 'origin', defaultBranch]);
command('git', ['merge-base', '--is-ancestor', sha, `origin/${defaultBranch}`]);
output('eligible', true);
output('source_sha', sha);
