import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { build, createServer, optimizeDeps, version } from 'vite';
import { loglineVitePlugin } from 'logline/vite-plugin';

const root = process.cwd();
const dependency = join(root, 'node_modules/synthetic-dependency');
mkdirSync(dependency, { recursive: true });
writeFileSync(
  join(dependency, 'package.json'),
  JSON.stringify({ name: 'synthetic-dependency', version: '1.0.0', type: 'module', exports: './index.js' }),
);
writeFileSync(
  join(dependency, 'index.js'),
  "import { LOG, WARN } from 'logline';\nexport function dependencyLog() { LOG('dependency-message'); WARN('dependency-warning'); }\nexport { base } from './base.js';\n",
);
writeFileSync(join(dependency, 'base.js'), 'export const base = __LOGLINE_VITE_BASE_URL__;');
writeFileSync(
  join(root, 'index.html'),
  '<html><head></head><body><script type="module" src="/main.ts"></script></body></html>',
);
writeFileSync(
  join(root, 'main.ts'),
  "import { DEBUG, WARN } from 'logline';\nimport { dependencyLog, base } from 'synthetic-dependency';\nDEBUG('remove-debug-message');\nWARN('keep-warning-message');\ndependencyLog();\nconsole.log(base);\n",
);
const config = {
  root,
  configFile: false,
  base: '/synthetic-base/',
  logLevel: 'silent',
  plugins: [loglineVitePlugin({ level: 'WARN', indexedDB: true, htmlInterop: true })],
  optimizeDeps: { include: ['synthetic-dependency'], noDiscovery: true },
};

/** Verify published declaration compatibility with the consumer's own Vite types. */
test(`Vite ${version}: strict public types`, () => {
  writeFileSync(
    join(root, 'consumer.ts'),
    "import { defineConfig } from 'vite';\nimport { loglineVitePlugin } from 'logline/vite-plugin';\nexport default defineConfig({ plugins: [loglineVitePlugin({ indexedDB: true, htmlInterop: true })] });\n",
  );
  execFileSync(
    process.execPath,
    [
      'node_modules/typescript/bin/tsc',
      '--noEmit',
      '--strict',
      '--module',
      'ESNext',
      '--moduleResolution',
      'bundler',
      '--target',
      'ES2022',
      'consumer.ts',
    ],
    { cwd: root, stdio: 'inherit' },
  );
});

/** Exercise actual serve hooks and each major's native dependency optimizer. */
test(`Vite ${version}: development transforms and dependency optimization`, async () => {
  const server = await createServer({ ...config, server: { middlewareMode: true, watch: null } });
  try {
    const html = await server.transformIndexHtml('/synthetic-base/', readFileSync(join(root, 'index.html'), 'utf8'));
    assert.match(html, /__LOGLINE_HTML_INTEROP__/);
    const transformed = await server.transformRequest('/main.ts');
    assert.ok(transformed?.map?.mappings, 'Entry transform must preserve sourcemaps');
    assert.match(transformed.code, /\[main.ts:3:1\] remove-debug-message/);
    assert.match(transformed.code, /keep-warning-message/);
    assert.match(transformed.code, /logline\/auto-indexeddb/);
    const metadata = await optimizeDeps(server.config, true);
    const optimized = metadata.optimized['synthetic-dependency'];
    assert.ok(optimized, 'Synthetic dependency must be prebundled');
    const code = readFileSync(optimized.file, 'utf8');
    assert.match(code, /\[npm:synthetic-dependency index.js:2:35 dependencyLog\] dependency-message/);
    assert.match(code, /synthetic-base/);
    assert.ok(!code.includes('__LOGLINE_VITE_BASE_URL__'));
    // Feed the optimizer output back through Vite to detect duplicate attribution.
    const result = await server.transformRequest(`/@fs/${optimized.file}`);
    assert.ok(result);
    assert.equal(result.code.match(/\[npm:synthetic-dependency /g)?.length, 2);
    assert.match(result.code, /dependency-warning/);
  } finally {
    await server.close();
  }
});

/** Exercise tree shaking, startup capture, persistence initialization, and source maps in real builds. */
test(`Vite ${version}: production build`, async () => {
  await build({ ...config, build: { minify: false, sourcemap: true } });
  const assets = join(root, 'dist/assets');
  const code = readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(assets, name), 'utf8'))
    .join('\n');
  assert.ok(!code.includes('remove-debug-message'));
  assert.match(code, /\[main.ts:4:1\] keep-warning-message/);
  // LOG is below WARN and must also be stripped in npm dependencies.
  assert.ok(!code.includes('dependency-message'));
  assert.match(code, /\[npm:synthetic-dependency index.js:2:62 dependencyLog\] dependency-warning/);
  assert.match(code, /synthetic-base/);
  assert.ok(!code.includes('__LOGLINE_VITE_BASE_URL__'));
  assert.match(code, /installIndexedDBLoggingPluginFromVite/);
  assert.match(readFileSync(join(root, 'dist/index.html'), 'utf8'), /__LOGLINE_HTML_INTEROP__/);
  const maps = readdirSync(assets)
    .filter((name) => name.endsWith('.js.map'))
    .map((name) => JSON.parse(readFileSync(join(assets, name), 'utf8')));
  assert.ok(
    maps.some((map) => map.mappings && map.sources.some((source) => resolve(assets, source) === join(root, 'main.ts'))),
  );
});
