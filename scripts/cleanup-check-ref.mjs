import assert from 'node:assert/strict';
import { api, project } from './release-contract.mjs';

/** Delete only an exact synthetic validation ref after all of its CI consumers have stopped. */
const { repository } = project();
const id = Number(process.env.COMPLETED_RUN_ID);
assert.ok(Number.isSafeInteger(id) && id > 0);
const run = api(`repos/${repository}/actions/runs/${id}`);
assert.equal(run.status, 'completed');
assert.equal(run.repository.full_name, repository);
if (!/^codex\/ci\/pr-\d+-[a-f0-9]{12}-[a-f0-9]{12}$/.test(run.head_branch || '')) process.exit(0);
const consumers = api(
  `repos/${repository}/actions/workflows/ci.yml/runs?branch=${encodeURIComponent(run.head_branch)}&per_page=100`,
).workflow_runs;
if (consumers.some((consumer) => consumer.status !== 'completed')) {
  process.stdout.write('Synthetic ref still has an active consumer; later completion will retry cleanup.\n');
  process.exit(0);
}
const path = `heads/${run.head_branch}`;
const existing = api(`repos/${repository}/git/matching-refs/${path}`).find((ref) => ref.ref === `refs/${path}`);
if (existing) {
  assert.equal(existing.object.sha, run.head_sha, 'Synthetic ref identity changed; refusing deletion');
  api(`repos/${repository}/git/refs/${path}`, { method: 'DELETE' });
}
assert.ok(!api(`repos/${repository}/git/matching-refs/${path}`).some((ref) => ref.ref === `refs/${path}`));
process.stdout.write('Exact completed synthetic validation ref removed.\n');
