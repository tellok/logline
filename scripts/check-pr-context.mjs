import assert from 'node:assert/strict';
import { api, command, project } from './release-contract.mjs';

/** Verify that this checkout represents the newest source merged into the newest target. */
const event = process.env.GITHUB_EVENT_NAME;
const number = Number(process.env.PR_NUMBER || 0);
if (event === 'pull_request' || number) {
  assert.ok(Number.isSafeInteger(number) && number > 0);
  const { repository } = project();
  const pr = api(`repos/${repository}/pulls/${number}`);
  assert.equal(pr.state, 'open', 'PR is no longer open');
  const baseSha = api(`repos/${repository}/git/ref/heads/${pr.base.ref}`).object.sha;
  const headSha = pr.head.sha;
  if (process.env.EXPECTED_HEAD) assert.equal(headSha, process.env.EXPECTED_HEAD, 'PR source advanced');
  if (process.env.EXPECTED_BASE) assert.equal(baseSha, process.env.EXPECTED_BASE, 'PR target advanced');
  const parents = command('git', ['show', '-s', '--format=%P']).trim().split(' ');
  assert.deepEqual(parents, [baseSha, headSha], 'Checkout is not the current native merge result');
  process.stdout.write(
    `PR #${number}: source ${headSha}; target ${baseSha}; merge ${command('git', ['rev-parse', 'HEAD']).trim()}.\n`,
  );
}
