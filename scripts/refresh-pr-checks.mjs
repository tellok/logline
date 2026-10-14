import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { api, command, project } from './release-contract.mjs';

/** Schedule current native merge results for same-repository PRs without changing source or target refs. */
const { repository } = project();
const selected = Number(process.env.PR_NUMBER || 0);
const target = process.env.TARGET_BRANCH;
const requests = selected
  ? [api(`repos/${repository}/pulls/${selected}`)]
  : api(`repos/${repository}/pulls?state=open&base=${encodeURIComponent(target)}&per_page=100`, { paginate: true });
const failures = [];
for (let pr of requests) {
  try {
    assert.equal(pr.state, 'open');
    if (pr.head.repo?.full_name !== repository) {
      const checks = api(`repos/${repository}/commits/${pr.head.sha}/check-runs?per_page=100`).check_runs;
      const pending = checks.find((check) => check.name === 'Merged result validation');
      const fields = {
        name: 'Merged result validation',
        head_sha: pr.head.sha,
        status: 'completed',
        conclusion: 'action_required',
      };
      if (pending) api(`repos/${repository}/check-runs/${pending.id}`, { method: 'PATCH', fields });
      else api(`repos/${repository}/check-runs`, { method: 'POST', fields });
      process.stdout.write(
        `PR #${pr.number}: external fork requires native execution approval and a fresh merged-result run; no privileged dispatch.\n`,
      );
      continue;
    }
    let baseSha;
    let merge;
    for (let attempt = 0; attempt < 5; attempt++) {
      pr = api(`repos/${repository}/pulls/${pr.number}`);
      baseSha = api(`repos/${repository}/git/ref/heads/${pr.base.ref}`).object.sha;
      if (pr.mergeable === false) throw new Error(`PR #${pr.number} has merge conflicts`);
      if (pr.merge_commit_sha) {
        merge = api(`repos/${repository}/git/commits/${pr.merge_commit_sha}`);
        if (merge.parents[0]?.sha === baseSha && merge.parents[1]?.sha === pr.head.sha) break;
      }
      merge = undefined;
      await setTimeout(2000);
    }
    assert.ok(merge, 'GitHub native merge ref is stale or unavailable');
    const runs = api(`repos/${repository}/actions/workflows/ci.yml/runs?per_page=100`).workflow_runs;
    for (const run of runs) {
      if (
        ['queued', 'in_progress', 'waiting', 'pending'].includes(run.status) &&
        (run.head_branch?.startsWith(`codex/ci/pr-${pr.number}-`) ||
          run.pull_requests?.some((item) => item.number === pr.number))
      ) {
        api(`repos/${repository}/actions/runs/${run.id}/cancel`, { method: 'POST' });
      }
    }
    const ref = `codex/ci/pr-${pr.number}-${pr.head.sha.slice(0, 12)}-${baseSha.slice(0, 12)}`;
    const existing = api(`repos/${repository}/git/matching-refs/heads/${ref}`).find(
      (entry) => entry.ref === `refs/heads/${ref}`,
    );
    if (existing) assert.equal(existing.object.sha, merge.sha);
    else api(`repos/${repository}/git/refs`, { method: 'POST', fields: { ref: `refs/heads/${ref}`, sha: merge.sha } });
    const current = api(`repos/${repository}/pulls/${pr.number}`);
    assert.equal(current.head.sha, pr.head.sha);
    assert.equal(api(`repos/${repository}/git/ref/heads/${pr.base.ref}`).object.sha, baseSha);
    command('gh', [
      'workflow',
      'run',
      'ci.yml',
      '--repo',
      repository,
      '--ref',
      ref,
      '-f',
      `pr_number=${pr.number}`,
      '-f',
      `source_sha=${pr.head.sha}`,
      '-f',
      `target_sha=${baseSha}`,
    ]);
    process.stdout.write(`Scheduled PR #${pr.number} against ${baseSha}.\n`);
  } catch (error) {
    failures.push(`PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length) throw new Error(failures.join('\n'));
