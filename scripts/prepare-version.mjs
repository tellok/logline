import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  api,
  command,
  pendingChangesets,
  prepareFiles,
  project,
  root,
  VERSION_BRANCH,
  VERSION_FILES,
  VERSION_MARKER,
} from './release-contract.mjs';

const { repository, defaultBranch } = project();
const baseSha = command('git', ['rev-parse', 'HEAD']).trim();
assert.equal(
  api(`repos/${repository}/git/ref/heads/${defaultBranch}`).object.sha,
  baseSha,
  'Default branch advanced; rerun preparation',
);
if (!pendingChangesets().length) {
  process.stdout.write('No unconsumed Changesets; no installation, build, or version PR needed.\n');
  process.exit(0);
}
const existing = api(
  `repos/${repository}/pulls?state=open&head=${repository.split('/')[0]}:${VERSION_BRANCH}&base=${defaultBranch}&per_page=100`,
  { paginate: true },
);
assert.ok(existing.length <= 1);
if (existing[0]) assert.ok(existing[0].body.includes(VERSION_MARKER), 'Refusing to overwrite an unmanaged PR');
const refs = api(`repos/${repository}/git/matching-refs/heads/${VERSION_BRANCH}`);
const old = refs.find((item) => item.ref === `refs/heads/${VERSION_BRANCH}`)?.object.sha ?? '';
const plan = prepareFiles(root, baseSha);
command('git', ['switch', '-C', VERSION_BRANCH]);
command('git', ['config', 'user.name', 'tellok']);
command('git', ['config', 'user.email', '5621862+tellok@users.noreply.github.com']);
command('git', ['add', ...VERSION_FILES]);
command('git', ['commit', '-m', `chore: release ${plan.package} ${plan.version}`]);
assert.equal(
  api(`repos/${repository}/git/ref/heads/${defaultBranch}`).object.sha,
  baseSha,
  'Default branch advanced during preparation',
);
command('git', [
  'push',
  `--force-with-lease=refs/heads/${VERSION_BRANCH}:${old}`,
  'origin',
  `HEAD:refs/heads/${VERSION_BRANCH}`,
]);
command('gh', [
  'label',
  'create',
  'release:version',
  '--repo',
  repository,
  '--color',
  '0e8a16',
  '--description',
  'Managed Changesets version PR',
  '--force',
]);
const managed = `${VERSION_MARKER}\n## Proposed beta release\n\nVersion: ${plan.version}\nBase source: ${baseSha}\nPackage: ${plan.package}\nChannel: beta\n\n${plan.changesets.map((item) => `- ${item.summary}`).join('\n')}\n\nNot published yet. Merging this version PR authorizes its verified beta release.\n<!-- /logline-version-pr -->`;
const oldBody = existing[0]?.body ?? '';
const body = oldBody.includes(VERSION_MARKER)
  ? oldBody.replace(/<!-- logline-version-pr -->[\s\S]*?<!-- \/logline-version-pr -->/, managed)
  : managed;
const file = join(tmpdir(), `logline-version-pr-${process.pid}.md`);
writeFileSync(file, body);
if (existing[0])
  command('gh', [
    'pr',
    'edit',
    String(existing[0].number),
    '--repo',
    repository,
    '--title',
    `chore: release ${plan.package} ${plan.version}`,
    '--body-file',
    file,
    '--add-label',
    'release:version',
  ]);
else
  command('gh', [
    'pr',
    'create',
    '--repo',
    repository,
    '--base',
    defaultBranch,
    '--head',
    VERSION_BRANCH,
    '--title',
    `chore: release ${plan.package} ${plan.version}`,
    '--body-file',
    file,
    '--label',
    'release:version',
  ]);
const prs = api(
  `repos/${repository}/pulls?state=open&head=${repository.split('/')[0]}:${VERSION_BRANCH}&base=${defaultBranch}&per_page=100`,
  { paginate: true },
);
assert.equal(prs.length, 1, 'Unable to confirm version PR after write');
command('gh', [
  'workflow',
  'run',
  'refresh-pr-checks.yml',
  '--repo',
  repository,
  '--ref',
  defaultBranch,
  '-f',
  `pr_number=${prs[0].number}`,
]);
process.stdout.write(`Version PR: ${prs[0].html_url}\n`);
