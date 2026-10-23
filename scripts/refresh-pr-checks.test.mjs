import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

const repository = 'example/synthetic-project';
const source = 'a'.repeat(40);
const target = 'b'.repeat(40);
const merge = 'c'.repeat(40);
const prefix = `repos/${repository}`;
const pr = {
  number: 7,
  state: 'open',
  head: { sha: source, repo: { full_name: repository } },
  base: { ref: 'integration' },
  merge_commit_sha: merge,
};

/** Exercise the real controller with an isolated CLI stub; unknown API calls fail without network access. */
const runController = (branch, requests) => {
  const folder = mkdtempSync(join(tmpdir(), 'logline-refresh-'));
  try {
    const responses = {
      [prefix]: { default_branch: 'integration' },
      [`${prefix}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=100`]: [requests],
      [`${prefix}/pulls/7`]: pr,
      [`${prefix}/git/ref/heads/integration`]: { object: { sha: target } },
      [`${prefix}/git/commits/${merge}`]: { parents: [{ sha: target }, { sha: source }], sha: merge },
      [`${prefix}/actions/workflows/ci.yml/runs?per_page=100`]: { workflow_runs: [] },
      [`${prefix}/git/matching-refs/heads/codex/ci/pr-7-${source.slice(0, 12)}-${target.slice(0, 12)}`]: [],
      [`${prefix}/git/refs`]: {},
    };
    const calls = join(folder, 'calls.jsonl');
    const cli = join(folder, 'gh');
    writeFileSync(
      cli,
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'workflow') process.exit(0);
const responses = ${JSON.stringify(responses)};
if (!Object.hasOwn(responses, args[1])) throw new Error('Unexpected API request: ' + args[1]);
process.stdout.write(JSON.stringify(responses[args[1]]));
`,
    );
    chmodSync(cli, 0o755);
    const output = execFileSync(process.execPath, [new URL('./refresh-pr-checks.mjs', import.meta.url).pathname], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${folder}${delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: repository,
        TARGET_BRANCH: branch,
        PR_NUMBER: '',
      },
    });
    return { output, calls: readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
};

test('a source-only push does not dispatch or cancel native PR CI', () => {
  const { output, calls } = runController('feature/synthetic', []);
  assert.match(output, /source updates are handled by native PR CI/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((args) => args[0] === 'api' && !args.includes('POST')));
  assert.ok(calls[1][1].includes('base=feature%2Fsynthetic'));
});

test('a target push dispatches the current merged result for affected PRs', () => {
  const { calls } = runController('integration', [pr]);
  const dispatched = calls.filter((args) => args[0] === 'workflow');
  assert.equal(dispatched.length, 1);
  assert.ok(dispatched[0].includes(`source_sha=${source}`));
  assert.ok(dispatched[0].includes(`target_sha=${target}`));
  assert.ok(dispatched[0].includes(`codex/ci/pr-7-${source.slice(0, 12)}-${target.slice(0, 12)}`));
});
