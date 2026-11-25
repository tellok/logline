import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './release-contract.mjs';

/** Run all quality gates, audit actual test execution, and build the product exactly once. */
const run = (program, args) => execFileSync(program, args, { cwd: root, stdio: 'inherit' });
function checkTap(name, args) {
  const tap = execFileSync('pnpm', args, { cwd: root, encoding: 'utf8' });
  process.stdout.write(tap);
  const count = Number(tap.match(/^# tests (\d+)$/m)?.[1]);
  assert.ok(count > 0, `${name} suite is empty`);
  for (const counter of ['fail', 'cancelled', 'skipped', 'todo'])
    assert.match(tap, new RegExp(`^# ${counter} 0$`, 'm'), `${name} ${counter} count must be zero`);
  return count;
}
const folder = mkdtempSync(join(tmpdir(), 'logline-verification-'));
try {
  run('pnpm', ['run', 'type-check']);
  run('pnpm', ['run', 'lint']);
  const contracts = checkTap('Release-contract', ['run', 'test:release']);
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
  assert.ok(
    process.env.TEST_DATABASE_URL,
    'Set TEST_DATABASE_URL to a disposable PostgreSQL database for verification',
  );
  const server = checkTap('Server', ['--filter', 'logline-server', 'test']);
  const reporter = checkTap('Reporter', ['--filter', 'logline-server-reporter', 'test']);
  const cli = checkTap('CLI', ['--filter', 'logline-server-cli', 'test']);
  run(process.execPath, ['scripts/prepare-package.mjs']);
  run(process.execPath, ['scripts/check-package.mjs', '--reporter', '--cli']);
  run(process.execPath, ['scripts/check-packed-reporting.mjs']);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Validated core (${tests.numPassedTests}), server (${server}), reporter (${reporter}), CLI (${cli}) and release-contract (${contracts}) tests with zero skips, types, lint, formatting, build, CLI executable and packed library checks. Reports remained job-local.\n`,
    );
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
