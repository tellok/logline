import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import MagicString from 'magic-string';
import dts from 'unplugin-dts/vite';
import { defineConfig, type Plugin } from 'vite';
import { externalizeDeps } from 'vite-plugin-externalize-deps';

const root = dirname(fileURLToPath(import.meta.url));
const runtimeViteBaseMarker = '__LOGLINE_RUNTIME_VITE_BASE_URL__';

/** Preserve the application's Vite base expression, with a safe CommonJS fallback. */
const preserveRuntimeViteBase = (): Plugin => ({
  name: 'preserve-runtime-vite-base',
  renderChunk(code, _chunk, outputOptions) {
    if (!code.includes(runtimeViteBaseMarker)) return undefined;
    const replacement = outputOptions.format === 'es' ? 'import.meta.env?.BASE_URL' : 'undefined';
    const source = new MagicString(code);
    source.replaceAll(runtimeViteBaseMarker, replacement);
    return { code: source.toString(), map: source.generateMap({ hires: true, includeContent: true }) };
  },
});

/** Collect public plugin entries so every subpath emits code and declarations. */
const collectPluginEntries = () => {
  const pluginsDir = resolve(root, 'src/plugins');
  return readdirSync(pluginsDir, { withFileTypes: true }).reduce<Record<string, string>>((entries, entry) => {
    if (entry.isDirectory()) entries[`plugins/${entry.name}/index`] = join(pluginsDir, entry.name, 'index.ts');
    return entries;
  }, {});
};

export default defineConfig({
  define: { 'process.env.LOGLINE_MODULE_ID': JSON.stringify('logline') },
  plugins: [
    externalizeDeps(),
    dts({ entryRoot: 'src', include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts'] }),
    preserveRuntimeViteBase(),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(root, 'src/index.ts'),
        'auto-import': resolve(root, 'src/auto-import.ts'),
        'html-interop': resolve(root, 'src/html-interop.ts'),
        'vite-plugin': resolve(root, 'src/vite-plugin.ts'),
        ...collectPluginEntries(),
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: { output: { preserveModules: true, preserveModulesRoot: 'src', exports: 'named' } },
    sourcemap: true,
    minify: false,
  },
});
