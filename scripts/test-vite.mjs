import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const supportedMajors = ['5', '6', '7', '8'];
const majors = process.argv.slice(2).filter((argument) => argument !== '--');
if (majors.length === 0) majors.push(...supportedMajors);
assert.ok(
  majors.every((major) => supportedMajors.includes(major)),
  'Expected supported Vite majors: 5, 6, 7, 8',
);

/** Pack the existing build and test isolated consumers against fresh major-range resolutions. */
const folder = realpathSync(mkdtempSync(join(tmpdir(), 'logline-vite-compatibility-')));
const run = (program, args, cwd) => execFileSync(program, args, { cwd, stdio: 'inherit' });
try {
  execFileSync('pnpm', ['pack', '--pack-destination', folder], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
  });
  const archive = readdirSync(folder).find((name) => name.endsWith('.tgz'));
  assert.ok(archive, 'Expected a packed Logline build; run pnpm run build first');
  for (const major of majors) {
    const consumer = mkdtempSync(join(folder, `vite-${major}-`));
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'synthetic-vite-consumer', private: true, type: 'module' }),
    );
    // A fresh install resolves the latest stable patch/minor within this major, independently of the repository lockfile.
    run(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        join(folder, archive),
        `vite@${major}`,
        'typescript@5.8.2',
        '@types/node@24',
      ],
      consumer,
    );
    copyFileSync(new URL('./fixtures/vite-consumer.mjs', import.meta.url), join(consumer, 'vite-consumer.mjs'));
    run(process.execPath, ['--test', 'vite-consumer.mjs'], consumer);
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
