import { build as esbuild } from 'esbuild';
import MagicString from 'magic-string';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceMapConsumer, type RawSourceMap } from 'source-map-js';
import { build as viteBuild, type Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { HTML_INTEROP_DETACH_KEY } from './html-interop/html-interop-shared';
import { LOGLINE_VITE_BASE_MARKER } from './core/constants';
import { loglineVitePlugin } from './vite-plugin';

const temporaryDirectories: string[] = [];
const indexedDBPluginEntry = join(dirname(fileURLToPath(import.meta.url)), 'plugins/indexeddb/index.ts');
const loglineRuntimeEntry = join(dirname(fileURLToPath(import.meta.url)), 'core/config.ts');

/**
 * Invoke Vite hooks in either function or object form.
 * @param hook Vite plugin hook.
 * @param thisArg Hook execution context.
 * @param args Hook arguments.
 */
const invokeHook = async (hook: unknown, thisArg: object, args: readonly unknown[]): Promise<unknown> => {
  if (typeof hook === 'function') return Reflect.apply(hook, thisArg, args);
  if (hook && typeof hook === 'object' && 'handler' in hook && typeof hook.handler === 'function') {
    return Reflect.apply(hook.handler, thisArg, args);
  }
  return undefined;
};

/**
 * Find a named plugin in Logline's single or combined plugin result.
 * @param result Result returned by loglineVitePlugin.
 * @param name Target plugin name.
 */
const findPlugin = (result: Plugin | Plugin[], name: string): Plugin => {
  const plugins = Array.isArray(result) ? result : [result];
  const plugin = plugins.find((candidate) => candidate.name === name);
  if (!plugin) throw new Error(`Vite plugin not found:${name}`);
  return plugin;
};

/**
 * Read code from a Vite transform result.
 * @param result Vite transform result.
 */
const readTransformedCode = (result: unknown): string => {
  if (!result || typeof result !== 'object' || !('code' in result) || typeof result.code !== 'string') {
    throw new Error('Expected Vite transform to return code');
  }
  return result.code;
};

/**
 * Convert a character offset into a zero-based sourcemap column.
 * @param code Complete generated code.
 * @param index Target character offset.
 */
const resolveGeneratedPosition = (code: string, index: number): { readonly column: number; readonly line: number } => {
  const before = code.slice(0, index);
  const lines = before.split('\n');
  return {
    column: lines.at(-1)?.length ?? 0,
    line: lines.length,
  };
};

/**
 * Create a temporary npm tree containing an application, direct dependency, and transitive dependency.
 */
const createFixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'logline-vite-plugin-')));
  temporaryDirectories.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo-app' }));

  const packageARoot = join(root, 'node_modules/npm-a');
  const packageBRoot = join(packageARoot, 'node_modules/@example/npm-b');
  mkdirSync(join(packageARoot, 'dist'), { recursive: true });
  mkdirSync(join(packageBRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageARoot, 'package.json'), JSON.stringify({ name: 'npm-a' }));
  writeFileSync(join(packageBRoot, 'package.json'), JSON.stringify({ name: '@example/npm-b' }));

  return {
    packageAFile: join(packageARoot, 'dist/a.js'),
    packageBFile: join(packageBRoot, 'dist/sdd.js'),
    root,
  };
};

/**
 * Run the plugin's ordinary module transform hook.
 * @param root Vite project root.
 * @param id Absolute module path.
 * @param code Module code.
 */
const transform = async (root: string, id: string, code: string): Promise<string> => {
  const plugin = findPlugin(loglineVitePlugin({ logPrefixMacro: { sourcemapRetrack: false } }), 'logline-pure-strip');
  await invokeHook(plugin.configResolved, {}, [{ root, logger: { info: () => undefined } }]);
  const result = await invokeHook(plugin.transform, { getCombinedSourcemap: () => undefined }, [code, id]);
  return readTransformedCode(result);
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('loglineVitePlugin npm attribution', () => {
  it('inline HTML Interop output excludes forbidden HTML control characters', async () => {
    const fixture = createFixture();
    const indexHtml = join(fixture.root, 'index.html');
    const html = '<html><head></head><body></body></html>';
    writeFileSync(indexHtml, html);
    const pluginResult = loglineVitePlugin({ htmlInterop: true, logPrefixMacro: false });
    const macroPlugin = findPlugin(pluginResult, 'logline-pure-strip');
    const bootstrapPlugin = findPlugin(pluginResult, 'logline-bootstrap');
    await invokeHook(macroPlugin.config, {}, [{ root: fixture.root }, { command: 'build', mode: 'production' }]);

    const transformedHtml = await invokeHook(bootstrapPlugin.transformIndexHtml, {}, [
      html,
      { filename: indexHtml, path: '/index.html' },
    ]);

    expect(typeof transformedHtml).toBe('string');
    expect(transformedHtml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });

  it('does not inject automatic IndexedDB initialization by default', async () => {
    const fixture = createFixture();
    const indexHtml = join(fixture.root, 'index.html');
    const appFile = join(fixture.root, 'src/main.ts');
    const html = '<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>';
    const code = "console.log('default-disabled');\n";
    mkdirSync(join(fixture.root, 'src'), { recursive: true });
    writeFileSync(indexHtml, html);
    writeFileSync(appFile, code);
    const plugin = findPlugin(loglineVitePlugin({ logPrefixMacro: false }), 'logline-pure-strip');
    await invokeHook(plugin.config, {}, [{ root: fixture.root }, { command: 'build', mode: 'production' }]);
    await invokeHook(plugin.configResolved, {}, [
      {
        base: '/',
        cacheDir: join(fixture.root, 'node_modules/.vite'),
        root: fixture.root,
        logger: { info: () => undefined },
      },
    ]);
    await invokeHook(plugin.transformIndexHtml, {}, [html, { filename: indexHtml, path: '/index.html' }]);

    const result = await invokeHook(plugin.transform, { getCombinedSourcemap: () => undefined }, [code, appFile]);

    expect(result).toBeUndefined();
  });

  it('preserves manual IndexedDB configuration when automatic initialization is disabled', async () => {
    const fixture = createFixture();
    const indexHtml = join(fixture.root, 'index.html');
    const sourceDirectory = join(fixture.root, 'src');
    const appFile = join(sourceDirectory, 'main.ts');
    const appSource =
      "import { configureLogline } from 'logline';\n" +
      "import { createIndexedDBLoggingPlugin } from 'logline/plugin/indexeddb';\n" +
      "const indexedDBPlugin = createIndexedDBLoggingPlugin({ databaseName: 'manual-vite-disabled-test' });\n" +
      'configureLogline({ plugins: [indexedDBPlugin] });\n' +
      "console.log('LOGLINE_MANUAL_INDEXEDDB_SOURCE_MARKER');\n";
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      indexHtml,
      '<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>',
    );
    writeFileSync(appFile, appSource);

    const buildResult = await viteBuild({
      build: {
        minify: false,
        outDir: join(fixture.root, 'dist'),
        sourcemap: true,
        write: false,
      },
      configFile: false,
      logLevel: 'silent',
      plugins: [loglineVitePlugin({ logPrefixMacro: false })],
      resolve: {
        alias: [
          {
            find: 'logline/plugin/indexeddb',
            replacement: indexedDBPluginEntry,
          },
          {
            find: 'logline',
            replacement: loglineRuntimeEntry,
          },
        ],
      },
      root: fixture.root,
    });
    const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
    const entryChunk = outputs
      .flatMap((output) => ('output' in output ? output.output : []))
      .find((output) => output.type === 'chunk' && output.isEntry);
    if (!entryChunk || entryChunk.type !== 'chunk') {
      throw new Error('Expected an entry chunk from the manually configured IndexedDB build');
    }

    expect(entryChunk.moduleIds).not.toContain('\0virtual:logline/auto-indexeddb');
    expect(entryChunk.moduleIds).toContain(appFile);
    expect(entryChunk.moduleIds.some((id) => id.replace(/\\/g, '/').endsWith('/html-interop/html-interop.ts'))).toBe(
      false,
    );
    expect(entryChunk.moduleIds.some((id) => id.replace(/\\/g, '/').endsWith('/plugins/indexeddb/storage.ts'))).toBe(
      true,
    );
    expect(entryChunk.code).toContain('manual-vite-disabled-test');
    expect(entryChunk.code).toContain('LOGLINE_MANUAL_INDEXEDDB_SOURCE_MARKER');
  });

  it('injects a resolvable initialization module into the development application entry', async () => {
    const fixture = createFixture();
    const indexHtml = join(fixture.root, 'index.html');
    const appFile = join(fixture.root, 'src/main.ts');
    const html = '<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>';
    const code = "console.log('development-enabled');\n";
    mkdirSync(join(fixture.root, 'src'), { recursive: true });
    writeFileSync(indexHtml, html);
    writeFileSync(appFile, code);
    const pluginResult = loglineVitePlugin({
      indexedDB: {
        databaseName: 'development-auto-test',
      },
      logPrefixMacro: false,
    });
    const macroPlugin = findPlugin(pluginResult, 'logline-pure-strip');
    const bootstrapPlugin = findPlugin(pluginResult, 'logline-bootstrap');
    await invokeHook(macroPlugin.config, {}, [{ root: fixture.root }, { command: 'serve', mode: 'development' }]);
    await invokeHook(macroPlugin.configResolved, {}, [
      {
        base: '/',
        cacheDir: join(fixture.root, 'node_modules/.vite'),
        root: fixture.root,
        logger: { info: () => undefined },
      },
    ]);
    await invokeHook(bootstrapPlugin.transformIndexHtml, {}, [html, { filename: indexHtml, path: '/index.html' }]);

    const transformResult = await invokeHook(bootstrapPlugin.transform, {}, [code, appFile]);
    const transformedCode = readTransformedCode(transformResult);
    const resolvedId = await invokeHook(bootstrapPlugin.resolveId, {}, ['virtual:logline/auto-indexeddb']);
    const loadedModule = await invokeHook(bootstrapPlugin.load, {}, [resolvedId]);

    expect(transformedCode.startsWith('import "virtual:logline/auto-indexeddb";\n')).toBe(true);
    expect(resolvedId).toBe('\0virtual:logline/auto-indexeddb');
    expect(loadedModule).toContain('installIndexedDBLoggingPluginFromVite');
    expect(loadedModule).toContain('development-auto-test');
  });

  it('adds enabled initialization to the entry module graph and preserves its sourcemap', async () => {
    const fixture = createFixture();
    const indexHtml = join(fixture.root, 'index.html');
    const sourceDirectory = join(fixture.root, 'src');
    const appFile = join(sourceDirectory, 'main.ts');
    const appSource =
      "const firstLine = 'first';\n" +
      "export const sourceMarker = 'LOGLINE_AUTO_INDEXEDDB_SOURCE_MARKER';\n" +
      'console.log(firstLine, sourceMarker);\n';
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      indexHtml,
      '<html><head></head><body><script type="module" src="/src/main.ts"></script></body></html>',
    );
    writeFileSync(appFile, appSource);

    const buildResult = await viteBuild({
      build: {
        minify: false,
        outDir: join(fixture.root, 'dist'),
        sourcemap: true,
        write: false,
      },
      configFile: false,
      logLevel: 'silent',
      plugins: [
        loglineVitePlugin({
          indexedDB: {
            databaseName: 'vite-auto-test',
          },
          logPrefixMacro: false,
        }),
      ],
      resolve: {
        alias: {
          'logline/plugin/indexeddb': indexedDBPluginEntry,
        },
      },
      root: fixture.root,
    });
    const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
    const entryChunk = outputs
      .flatMap((output) => ('output' in output ? output.output : []))
      .find((output) => output.type === 'chunk' && output.isEntry);
    if (!entryChunk || entryChunk.type !== 'chunk' || !entryChunk.map) {
      throw new Error('Expected an entry sourcemap from the automatic IndexedDB build');
    }

    expect(entryChunk.moduleIds).toContain('\0virtual:logline/auto-indexeddb');
    expect(entryChunk.moduleIds).toContain(appFile);
    expect(entryChunk.code).toContain('vite-auto-test');
    const markerIndex = entryChunk.code.indexOf('LOGLINE_AUTO_INDEXEDDB_SOURCE_MARKER');
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const consumer = new SourceMapConsumer(JSON.parse(entryChunk.map.toString()) as RawSourceMap);
    const originalPosition = consumer.originalPositionFor(resolveGeneratedPosition(entryChunk.code, markerIndex));

    expect(originalPosition.source?.replace(/\\/g, '/')).toMatch(/\/src\/main\.ts$/);
    expect(originalPosition.line).toBe(2);
  });

  it('replaces the IndexedDB runtime marker with the final resolved base', async () => {
    const fixture = createFixture();
    const plugin = findPlugin(loglineVitePlugin({ logPrefixMacro: false }), 'logline-pure-strip');
    await invokeHook(plugin.configResolved, {}, [
      { base: '/branches/feature-a/', root: fixture.root, logger: { info: () => undefined } },
    ]);

    const result = await invokeHook(plugin.transform, { getCombinedSourcemap: () => undefined }, [
      `const markerLabel = '${LOGLINE_VITE_BASE_MARKER}';\n` +
        `const viteBase = typeof ${LOGLINE_VITE_BASE_MARKER} === 'undefined' ? undefined : ${LOGLINE_VITE_BASE_MARKER};`,
      join(fixture.root, 'node_modules/logline/dist/plugins/indexeddb/database-name.js'),
    ]);
    const transformedCode = readTransformedCode(result);

    expect(transformedCode).toContain('typeof "/branches/feature-a/"');
    expect(transformedCode).toContain(`markerLabel = '${LOGLINE_VITE_BASE_MARKER}'`);
  });

  it('attributes transitive dependencies to the nearest package and artifact position', async () => {
    const fixture = createFixture();
    const code = "import { LOG } from 'logline';\n  LOG('from B');\n";
    writeFileSync(fixture.packageBFile, code);

    const transformed = await transform(fixture.root, fixture.packageBFile, code);

    expect(transformed).toContain('LOG("[npm:@example/npm-b dist/sdd.js:2:3] from B")');
    expect(transformed).not.toContain('npm:npm-a');
    expect(transformed.match(/\[npm:/g)).toHaveLength(1);
  });

  it('uses the nearest artifact function name and omits names for top-level calls', async () => {
    const fixture = createFixture();
    const code =
      "import { LOG } from 'logline';\nfunction funb() {\n  LOG('function log');\n}\nLOG('top-level log');\n";
    writeFileSync(fixture.packageBFile, code);

    const transformed = await transform(fixture.root, fixture.packageBFile, code);

    expect(transformed).toContain('LOG("[npm:@example/npm-b dist/sdd.js:3:3 funb] function log")');
    expect(transformed).toContain('LOG("[npm:@example/npm-b dist/sdd.js:5:1] top-level log")');
  });

  it('prefers the name of a named artifact function expression', async () => {
    const fixture = createFixture();
    const code =
      "import { WARN } from 'logline';\nexport const alias = function funb() {\n  WARN('named function log');\n};\n";
    writeFileSync(fixture.packageBFile, code);

    const transformed = await transform(fixture.root, fixture.packageBFile, code);

    expect(transformed).toContain('WARN("[npm:@example/npm-b dist/sdd.js:3:3 funb] named function log")');
  });

  it('normalizes legacy nested npm prefixes to the innermost owner', async () => {
    const fixture = createFixture();
    const code =
      "import { LOG } from 'logline';\n  LOG('[npm:npm-a dist/a.js:4:2] [npm:@example/npm-b src/b.ts:8 run] from B');\n";
    writeFileSync(fixture.packageBFile, code);

    const transformed = await transform(fixture.root, fixture.packageBFile, code);

    expect(transformed).toContain('LOG("[npm:@example/npm-b dist/sdd.js:2:3] from B")');
    expect(transformed.match(/\[npm:/g)).toHaveLength(1);
  });

  it('does not rewrite unrelated same-name global functions in dependencies', async () => {
    const fixture = createFixture();
    const code = "export const run = () => LOG('ordinary function');\n";
    writeFileSync(fixture.packageAFile, code);
    const plugin = findPlugin(loglineVitePlugin({ logPrefixMacro: { sourcemapRetrack: false } }), 'logline-pure-strip');
    await invokeHook(plugin.configResolved, {}, [{ root: fixture.root, logger: { info: () => undefined } }]);

    const result = await invokeHook(plugin.transform, { getCombinedSourcemap: () => undefined }, [
      code,
      fixture.packageAFile,
    ]);

    expect(result).toBeUndefined();
  });

  it('handles chunk artifacts inside npm packages', async () => {
    const fixture = createFixture();
    const chunkFile = join(fixture.root, 'node_modules/npm-a/dist/chunk-shared.js');
    const code = "import { WARN } from 'logline';\nWARN('chunk log');\n";
    writeFileSync(chunkFile, code);

    const transformed = await transform(fixture.root, chunkFile, code);

    expect(transformed).toContain('[npm:npm-a dist/chunk-shared.js:2:1] chunk log');
  });

  it('preserves application prefixes and adds VS Code-compatible columns', async () => {
    const fixture = createFixture();
    const appFile = join(fixture.root, 'src/main.ts');
    const code = "import { LOG } from 'logline';\n  export const run = () => LOG('application log');\n";
    mkdirSync(join(fixture.root, 'src'), { recursive: true });
    writeFileSync(appFile, code);

    const transformed = await transform(fixture.root, appFile, code);

    expect(transformed).toContain('LOG("[main.ts:2:28 run] application log")');
    expect(transformed).not.toContain('npm:');
  });

  it('injects npm attribution before development dependency prebundling', async () => {
    const fixture = createFixture();
    const code =
      `import { LOG } from 'logline';\nexport const viteBase = ${LOGLINE_VITE_BASE_MARKER};\n` +
      "export function funa() {\n  LOG('prebundle log');\n}\n";
    writeFileSync(fixture.packageAFile, code);
    const plugin = findPlugin(loglineVitePlugin(), 'logline-pure-strip');
    const configResult = await invokeHook(plugin.config, {}, [
      { root: fixture.root },
      { command: 'serve', mode: 'development' },
    ]);
    if (!configResult || typeof configResult !== 'object' || !('optimizeDeps' in configResult)) {
      throw new Error('Expected injected optimizeDeps configuration');
    }
    const optimizeDeps = configResult.optimizeDeps;
    if (!optimizeDeps || typeof optimizeDeps !== 'object' || !('esbuildOptions' in optimizeDeps)) {
      throw new Error('Expected injected esbuildOptions configuration');
    }
    const esbuildOptions = optimizeDeps.esbuildOptions;
    if (!esbuildOptions || typeof esbuildOptions !== 'object' || !('plugins' in esbuildOptions)) {
      throw new Error('Expected injected esbuild plugins');
    }
    const plugins = esbuildOptions.plugins;
    if (!Array.isArray(plugins)) throw new Error('Expected an esbuild plugins array');
    await invokeHook(plugin.configResolved, {}, [
      { base: '/dev-branch/', root: fixture.root, logger: { info: () => undefined } },
    ]);

    const result = await esbuild({
      bundle: true,
      entryPoints: [fixture.packageAFile],
      external: ['logline'],
      format: 'esm',
      outfile: join(fixture.root, 'cache/npm-a.js'),
      plugins,
      sourcemap: 'external',
      write: false,
    });

    const outputCode = result.outputFiles?.find((file) => file.path.endsWith('.js'))?.text;
    const outputMap = result.outputFiles?.find((file) => file.path.endsWith('.js.map'))?.text;
    if (!outputCode || !outputMap) throw new Error('Expected code and sourcemap from dependency prebundling');
    expect(outputCode).toContain('viteBase = "/dev-branch/"');
    expect(outputCode).toContain('[npm:npm-a dist/a.js:4:3 funa]');
    const prefixIndex = outputCode.indexOf('[npm:npm-a');
    const rawMap = JSON.parse(outputMap) as RawSourceMap;
    const consumer = new SourceMapConsumer(rawMap);
    const originalPosition = consumer.originalPositionFor(resolveGeneratedPosition(outputCode, prefixIndex));

    expect(originalPosition.source?.replace(/\\/g, '/')).toMatch(/\/node_modules\/npm-a\/dist\/a\.js$/);
    expect(originalPosition.line).toBe(4);
    expect(originalPosition.column).toBe(6);
  });

  it('preserves artifact line and column locations in production CommonJS builds', async () => {
    const fixture = createFixture();
    const appFile = join(fixture.root, 'main.js');
    const packageCode =
      "const { LOG } = require('logline');\nfunction funa() {\n  LOG('production log');\n}\nfuna();\n";
    const packageJsonPath = join(fixture.root, 'node_modules/npm-a/package.json');
    const packageFile = join(fixture.root, 'node_modules/npm-a/dist/a.cjs');
    writeFileSync(packageJsonPath, JSON.stringify({ main: 'dist/a.cjs', name: 'npm-a' }));
    writeFileSync(packageFile, packageCode);
    writeFileSync(appFile, "import 'npm-a';\n");

    const buildResult = await viteBuild({
      build: {
        rollupOptions: {
          external: ['logline'],
          input: appFile,
        },
        write: false,
      },
      logLevel: 'silent',
      plugins: [loglineVitePlugin({ logPrefixMacro: { sourcemapRetrack: true } })],
      root: fixture.root,
    });
    const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
    const chunk = outputs
      .flatMap((output) => ('output' in output ? output.output : []))
      .find((output) => output.type === 'chunk');

    expect(chunk?.code).toContain('[npm:npm-a dist/a.cjs:3:3 funa]');
  });

  it('composes upstream sourcemaps and maps injected prefixes to published artifacts', async () => {
    const fixture = createFixture();
    const appFile = join(fixture.root, 'main.js');
    const packageCode =
      "import { LOG } from 'logline';\nexport function funa() {\n  LOG('production log');\n}\nfuna();\n";
    writeFileSync(
      join(fixture.root, 'node_modules/npm-a/package.json'),
      JSON.stringify({ exports: './dist/a.js', name: 'npm-a', type: 'module' }),
    );
    writeFileSync(fixture.packageAFile, packageCode);
    writeFileSync(appFile, "import 'npm-a';\n");

    const buildResult = await viteBuild({
      build: {
        rollupOptions: {
          external: ['logline'],
          input: appFile,
        },
        sourcemap: true,
        write: false,
      },
      logLevel: 'silent',
      plugins: [
        {
          enforce: 'pre',
          name: 'fixture-upstream-transform',
          transform(code, id) {
            if (id !== fixture.packageAFile) return undefined;
            const magicString = new MagicString(code);
            magicString.prepend('// intermediate code inserted by an upstream plugin\n');
            return {
              code: magicString.toString(),
              map: magicString.generateMap({ hires: true, includeContent: true, source: id }),
            };
          },
        },
        loglineVitePlugin({ logPrefixMacro: { sourcemapRetrack: true } }),
      ],
      root: fixture.root,
    });
    const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
    const chunk = outputs
      .flatMap((output) => ('output' in output ? output.output : []))
      .find((output) => output.type === 'chunk');
    if (!chunk?.map) throw new Error('Expected a production output sourcemap');

    expect(chunk.code).toContain('[npm:npm-a dist/a.js:3:3 funa]');
    const prefixIndex = chunk.code.indexOf('[npm:npm-a');
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    const generatedPosition = resolveGeneratedPosition(chunk.code, prefixIndex);
    const rawMap = JSON.parse(chunk.map.toString()) as RawSourceMap;
    const consumer = new SourceMapConsumer(rawMap);
    const originalPosition = consumer.originalPositionFor(generatedPosition);

    expect(originalPosition.source?.replace(/\\/g, '/')).toMatch(/\/node_modules\/npm-a\/dist\/a\.js$/);
    expect(originalPosition.line).toBe(3);
    expect(originalPosition.column).toBe(6);
    expect(rawMap.sourcesContent).toContain(packageCode);
    expect(
      rawMap.sourcesContent?.some((content) => content?.includes('intermediate code inserted by an upstream plugin')),
    ).toBe(false);
  });

  it('production entries do not stop HTML Interop capture early', async () => {
    const fixture = createFixture();
    const appFile = join(fixture.root, 'main.js');
    const appSource = "export const sourceMarker = 'LOGLINE_SOURCE_MARKER';\nconsole.log(sourceMarker);\n";
    writeFileSync(appFile, appSource);

    const buildResult = await viteBuild({
      build: {
        minify: false,
        rollupOptions: { input: appFile },
        sourcemap: true,
        write: false,
      },
      logLevel: 'silent',
      plugins: [loglineVitePlugin({ logPrefixMacro: false })],
      root: fixture.root,
    });
    const outputs = Array.isArray(buildResult) ? buildResult : [buildResult];
    const chunk = outputs
      .flatMap((output) => ('output' in output ? output.output : []))
      .find((output) => output.type === 'chunk');
    if (!chunk) throw new Error('Expected generated entry code');
    expect(chunk.code).not.toContain(HTML_INTEROP_DETACH_KEY);
  });
});
