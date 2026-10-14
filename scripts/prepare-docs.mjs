import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { root } from './release-contract.mjs';
import { documentationRoute, rewriteDocumentationLinks } from './docs-content.mjs';

/** Stage public Markdown without duplicating maintained content or including private/generated files. */
const sources = new Set([
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  ...readdirSync(join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/${name}`),
]);
const staging = join(root, '.docs-site');
rmSync(staging, { recursive: true, force: true });
for (const source of sources) {
  if (source === 'LICENSE') continue;
  const target = join(staging, documentationRoute(source));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, rewriteDocumentationLinks(readFileSync(join(root, source), 'utf8'), source, sources));
}
mkdirSync(join(staging, 'public'), { recursive: true });
writeFileSync(join(staging, 'public/LICENSE.txt'), readFileSync(join(root, 'LICENSE')));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
writeFileSync(
  join(staging, 'public/release.json'),
  `${JSON.stringify({ version: pkg.version, sourceSha }, undefined, 2)}\n`,
);
