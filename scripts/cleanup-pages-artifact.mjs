import assert from 'node:assert/strict';
import { api, project } from './release-contract.mjs';

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
process.stdout.write('Deleted the consumed Pages transfer artifact.\n');
