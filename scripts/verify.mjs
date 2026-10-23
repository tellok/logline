import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './release-contract.mjs';

/** Run all quality gates, audit actual test execution, and build the product exactly once. */
const run = (program, args) => execFileSync(program, args, { cwd: root, stdio: 'inherit' });
const folder = mkdtempSync(join(tmpdir(), 'logline-verification-'));
try {
  run('pnpm', ['run', 'type-check']);
  run('pnpm', ['run', 'lint']);
  const contractTests = execFileSync('pnpm', ['run', 'test:release'], { cwd: root, encoding: 'utf8' });
  process.stdout.write(contractTests);
  assert.ok(Number(contractTests.match(/^# tests (\d+)$/m)?.[1]) > 0, 'Release-contract suite is empty');
  for (const counter of ['fail', 'cancelled', 'skipped', 'todo'])
    assert.match(contractTests, new RegExp(`^# ${counter} 0$`, 'm'), `Release-contract ${counter} count must be zero`);
  const report = join(folder, 'vitest.json');
  run('pnpm', ['--filter', 'logline', 'test', '--reporter=json', `--outputFile=${report}`]);
  const tests = JSON.parse(readFileSync(report, 'utf8'));
  assert.ok(tests.numTotalTests > 0, 'An empty test suite cannot authorize release');
  assert.equal(tests.numPendingTests, 0, 'Skipped tests block release');
  assert.equal(tests.numFailedTests, 0);
  assert.equal(tests.numPassedTests, tests.numTotalTests);
  process.stdout.write(`Verified ${tests.numPassedTests}/${tests.numTotalTests} product tests; zero skipped.\n`);
  run('pnpm', ['run', 'format:check']);
  run('pnpm', ['run', 'build']);
  run(process.execPath, ['scripts/prepare-package.mjs']);
  run(process.execPath, ['scripts/check-package.mjs']);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Validated ${tests.numPassedTests} product tests, release-contract tests, types, lint, formatting, build, and public package exports. Reports remained job-local.\n`,
    );
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
