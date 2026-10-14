import assert from 'node:assert/strict';
import { api, command, project } from './release-contract.mjs';

/** Remove only this run's exact Pages transfer artifact after its sole deployment consumer has stopped. */
const { repository } = project();
const artifactId = Number(process.env.PAGES_ARTIFACT_ID);
const runId = Number(process.env.GITHUB_RUN_ID);
assert.ok(Number.isSafeInteger(artifactId) && artifactId > 0);
assert.ok(Number.isSafeInteger(runId) && runId > 0);
const path = `repos/${repository}/actions/artifacts/${artifactId}`;
const artifact = api(path);
assert.equal(artifact.name, 'github-pages');
assert.equal(artifact.workflow_run.id, runId, 'Pages artifact belongs to another workflow run');
api(path, { method: 'DELETE' });
const pages = JSON.parse(
  command('gh', ['api', `repos/${repository}/actions/artifacts?per_page=100`, '--paginate', '--slurp']),
);
assert.ok(!pages.flatMap((page) => page.artifacts).some((entry) => entry.id === artifactId));
process.stdout.write('Verified removal of the consumed Pages transfer artifact.\n');
