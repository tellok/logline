import { rmSync } from 'node:fs';

rmSync(new URL('../packages/logline-server-reporter/dist/', import.meta.url), { recursive: true, force: true });

/** Remove generated library outputs and documentation copies without touching maintained content. */
for (const path of ['dist', 'README.md', 'README.zh-CN.md', 'LICENSE', 'docs', 'skills']) {
  rmSync(new URL(`../packages/logline/${path}`, import.meta.url), { recursive: true, force: true });
}
