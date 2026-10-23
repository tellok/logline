import { cpSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Refresh distributed documentation from root sources; never modify maintained source files. */
export const preparePackage = (cwd = root) => {
  for (const path of ['README.md', 'README.zh-CN.md', 'LICENSE', 'docs', 'skills']) {
    const destination = resolve(cwd, 'packages/logline', path);
    rmSync(destination, { recursive: true, force: true });
    cpSync(resolve(cwd, path), destination, { recursive: true });
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) preparePackage();
