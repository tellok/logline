import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after builds and prepare-package.mjs. Pack the real workspace projects so pnpm performs
// its release-time workspace:* conversion; do not run prepack again or install a consumer graph.
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'logline-packed-reporting-'));
const require = createRequire(import.meta.url);
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const env = { ...process.env, npm_config_offline: 'true', COREPACK_ENABLE_NETWORK: '0', NODE_PATH: '' };
const run = (program, args, cwd) => execFileSync(program, args, { cwd, env, stdio: 'inherit' });

try {
  const modules = join(stage, 'node_modules');
  for (const name of ['logline', 'logserver-reporter']) {
    const project = join(root, 'packages', name);
    const archive = join(stage, `${name}.tgz`);
    const installed = join(modules, name);
    run('pnpm', ['--config.ignore-scripts=true', 'pack', '--out', archive], project);
    mkdirSync(installed, { recursive: true });
    run('tar', ['-xzf', archive, '--strip-components=1', '-C', installed], stage);
    const manifest = json(join(installed, 'package.json'));
    assert.equal(manifest.name, name);
    assert.equal(manifest.version, json(join(project, 'package.json')).version);
    for (const file of ['LICENSE', 'README.md', 'README.zh-CN.md']) {
      assert.ok(existsSync(join(installed, file)), `${name} tarball is missing ${file}`);
    }
  }

  const core = json(join(modules, 'logline/package.json'));
  const reporter = json(join(modules, 'logserver-reporter/package.json'));
  assert.equal(reporter.peerDependencies.logline, core.version, 'Packed reporter must pin the released core version');
  for (const doc of ['reporting.md', 'reporting.zh-CN.md']) {
    assert.deepEqual(
      readFileSync(join(modules, 'logline/docs', doc)),
      readFileSync(join(root, 'docs', doc)),
      `Stale distributed ${doc}`,
    );
  }

  const specifiers = ['logline', 'logline/plugin/reporting', 'logserver-reporter'];
  const bindings = [
    'configureLogline',
    'createReportingLoggingPlugin',
    'createLoglineServerTransport, createLoglineServerReporter',
  ];
  const runtimeProbe = `
const options = { baseUrl: 'https://example.invalid', projectId: '00000000-0000-4000-8000-000000000001', service: 'smoke', token: 'synthetic',
  fetch() { throw new Error('Unexpected request while constructing a reporter'); } };
const custom = createReportingLoggingPlugin({ transport: createLoglineServerTransport(options) });
const reporter = createLoglineServerReporter(options);
configureLogline({ plugins: [custom, reporter] });
for (const plugin of [custom, reporter]) {
  assert.equal(plugin.getMetrics().queued, 0);
  plugin.dispose();
}
`;
  for (const mode of ['mjs', 'cjs']) {
    const esm = mode === 'mjs';
    const lines = [esm ? "import assert from 'node:assert/strict';" : "const assert = require('node:assert/strict');"];
    for (const [index, spec] of specifiers.entries()) {
      lines.push(
        esm ? `import { ${bindings[index]} } from '${spec}';` : `const { ${bindings[index]} } = require('${spec}');`,
      );
      lines.push(
        esm
          ? `assert.ok(import.meta.resolve('${spec}').endsWith('.js'));`
          : `assert.ok(require.resolve('${spec}').endsWith('.cjs'));`,
      );
    }
    const path = join(stage, `consumer.${mode}`);
    writeFileSync(path, lines.join('\n') + runtimeProbe);
    run(process.execPath, [path], stage);
  }

  // The published client targets bundlers. Check real declarations with export-map resolution
  // and full library checking; no workspace aliases, declaration stubs or generated dist paths.
  writeFileSync(
    join(stage, 'consumer.ts'),
    `
import { configureLogline } from 'logline';
import { createReportingLoggingPlugin, type ReportingTransport } from 'logline/plugin/reporting';
import { createLoglineServerReporter, createLoglineServerTransport, type LoglineServerOptions } from 'logserver-reporter';
const options: LoglineServerOptions = { baseUrl: new URL('https://example.invalid'), projectId: 'synthetic', service: 'test', token: async () => 'synthetic' };
const transport: ReportingTransport = createLoglineServerTransport(options);
const custom = createReportingLoggingPlugin({ transport, transform: event => ({ ...event, message: event.message.toUpperCase() }) });
const reporter = createLoglineServerReporter({ ...options, reporting: { maxBatchEvents: 4 } });
configureLogline({ plugins: [custom, reporter] });
// @ts-expect-error An untyped reporter could hide broken declaration imports.
reporter.flush({ timeout: 'invalid' });
`,
  );
  writeFileSync(
    join(stage, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        types: [],
        strict: true,
        skipLibCheck: false,
        noEmit: true,
      },
      files: ['consumer.ts'],
    }),
  );
  run(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', join(stage, 'tsconfig.json')], stage);
  console.log(
    `Verified packed logline ${core.version} + logserver-reporter ${reporter.version}: released peer, docs, ESM, CJS and strict bundler TypeScript.`,
  );
} finally {
  assert.equal(dirname(stage), resolve(tmpdir()));
  rmSync(stage, { recursive: true, force: true });
}
