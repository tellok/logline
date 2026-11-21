import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export const VERSION_BRANCH = 'codex/version-packages';
export const VERSION_MARKER = '<!-- logline-version-pr -->';
export const PUBLIC_PACKAGES = ['logline', 'logserver-reporter'];
export const VERSION_FILES = [
  ...PUBLIC_PACKAGES.flatMap((name) =>
    ['package.json', 'CHANGELOG.md', 'CHANGELOG.zh-CN.md'].map((file) => `packages/${name}/${file}`),
  ),
  'pnpm-lock.yaml',
  '.changeset/pre.json',
  '.release/version-plan.json',
];
export const PACKAGE_MANIFEST = 'packages/logline/package.json';
export const root = fileURLToPath(new URL('../', import.meta.url));

/** Read a JSON contract from a checkout; malformed or missing files fail closed. */
export const readJson = (path, cwd = root) => JSON.parse(readFileSync(resolve(cwd, path), 'utf8'));

/** Execute a fixed command without a shell and return its text output. */
export const command = (program, args, cwd = root) =>
  execFileSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });

/** Call GitHub through its authenticated CLI; paginate list endpoints completely. */
export const api = (path, options = {}) => {
  const args = ['api', path];
  if (options.paginate) args.push('--paginate', '--slurp');
  if (options.method) args.push('--method', options.method);
  for (const [key, value] of Object.entries(options.fields ?? {})) args.push('-f', `${key}=${value}`);
  const text = command('gh', args);
  if (!text.trim()) return undefined;
  const value = JSON.parse(text);
  return options.paginate ? value.flat() : value;
};

/** Discover public project identity and the actual default branch from GitHub. */
export const project = () => {
  const repository =
    process.env.GITHUB_REPOSITORY ||
    readJson(PACKAGE_MANIFEST).repository.url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
  assert.ok(repository, 'Unable to discover GitHub repository');
  const metadata = api(`repos/${repository}`);
  return { repository, defaultBranch: metadata.default_branch };
};

/** Find unconsumed files using the pinned Changesets CLI's prerelease bookkeeping. */
export const pendingChangesets = (cwd = root) => {
  const pre = existsSync(resolve(cwd, '.changeset/pre.json')) ? readJson('.changeset/pre.json', cwd) : undefined;
  const consumed = new Set(pre?.mode === 'pre' ? pre.changesets : []);
  return readdirSync(resolve(cwd, '.changeset'))
    .filter(
      (name) =>
        name.endsWith('.md') && name !== 'README.md' && !name.startsWith('.') && !consumed.has(name.slice(0, -3)),
    )
    .sort();
};

/** Require the beta channel and prevent accidental stable-v2 publication. */
export const assertBeta = (pkg) => {
  assert.match(pkg.version, /^2\.\d+\.\d+-beta\.\d+$/);
  assert.equal(pkg.publishConfig?.tag, 'beta');
};

/** Validate both npm deliverables and return their single beta version. The server ships as an image only. */
export const pairedVersion = (cwd = root) => {
  const versions = PUBLIC_PACKAGES.map((name) => {
    const pkg = readJson(`packages/${name}/package.json`, cwd);
    assertBeta(pkg);
    assert.equal(pkg.name, name);
    assert.ok(!pkg.private, `${name} must be publishable`);
    return pkg.version;
  });
  assert.equal(new Set(versions).size, 1, 'Public npm packages must have matching beta versions');
  return versions[0];
};

/** Resolve the newest published stable v1 version, including its latest patch/minor. */
export const newestV1 = (versions) => {
  const semver = require('semver');
  const version = versions
    .filter((value) => semver.valid(value) && semver.major(value) === 1 && !semver.prerelease(value))
    .sort(semver.rcompare)[0];
  assert.ok(version, 'No published stable v1 version found');
  return version;
};

/** Extract exactly one release chapter; missing or duplicate chapters block delivery. */
export const releaseChapter = (text, version) => {
  const sections = [...text.matchAll(/^## ([^\r\n]+)\r?$/gm)];
  const matches = sections.filter((entry) => entry[1].trim() === version);
  assert.equal(matches.length, 1, `Expected exactly one changelog chapter for ${version}`);
  const entry = matches[0];
  const next = sections.find((candidate) => candidate.index > entry.index);
  return text.slice(entry.index, next?.index ?? text.length).trim();
};

/** Report narrowly scoped outputs to GitHub Actions or local command output. */
export const output = (name, value) => {
  assert.ok(!String(value).includes('\n'));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else process.stdout.write(`${name}=${value}\n`);
};

/** Consume Changesets without building a product and record deterministic public provenance. */
export const prepareFiles = (cwd, baseSha) => {
  const previousVersion = pairedVersion(cwd);
  const pre = readJson('.changeset/pre.json', cwd);
  assert.equal(pre.mode, 'pre');
  assert.equal(pre.tag, 'beta');
  assert.equal(readJson('package.json', cwd).devDependencies['@changesets/cli'], '2.29.7');
  const translations = readJson('.changeset/translations.json', cwd);
  const changesets = pendingChangesets(cwd).map((file) => {
    const id = file.slice(0, -3);
    const text = readFileSync(resolve(cwd, '.changeset', file), 'utf8');
    const [, header, body] = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/) ?? [];
    const summary = body?.trim();
    assert.ok(summary, `Missing Changeset summary: ${id}`);
    // Limit the release contract to one ordinary Changesets mapping entry per public package.
    const packages = header
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const entry = /^\s*(['"]?)([\w-]+)\1\s*:\s*(?:major|minor|patch)\s*$/.exec(line);
        assert.ok(entry && PUBLIC_PACKAGES.includes(entry[2]), `Invalid package entry in ${id}`);
        return entry[2];
      });
    assert.equal(typeof translations[id], 'string', `Missing Chinese translation: ${id}`);
    return {
      id,
      packages,
      sha256: createHash('sha256').update(text).digest('hex'),
      summary,
      translation: translations[id],
    };
  });
  assert.ok(changesets.length, 'No unconsumed Changesets');
  command(process.execPath, [resolve(root, 'node_modules/@changesets/cli/bin.js'), 'version'], cwd);
  const version = pairedVersion(cwd);
  assert.notEqual(version, previousVersion, 'A nonempty release must advance the beta');
  for (const name of PUBLIC_PACKAGES) {
    const summaries = changesets.filter((item) => item.packages.includes(name)).map((item) => item.translation);
    const path = resolve(cwd, `packages/${name}/CHANGELOG.zh-CN.md`);
    const chinese = readFileSync(path, 'utf8');
    const chapter = `## ${version}\n\n${(summaries.length ? summaries : ['与配套 npm 包同步升级 beta 版本。']).map((summary) => `- ${summary}`).join('\n')}\n\n`;
    writeFileSync(
      path,
      chinese.replace(/(^# [^\n]+\n)/, (heading) => `${heading}\n${chapter}`),
    );
    // The pinned CLI may omit a chapter for a fixed package with no direct changes.
    const englishPath = resolve(cwd, `packages/${name}/CHANGELOG.md`);
    const english = readFileSync(englishPath, 'utf8');
    if (!summaries.length && !english.split(/\r?\n/).includes(`## ${version}`))
      writeFileSync(
        englishPath,
        english.replace(
          /(^# [^\n]+\n)/,
          (heading) => `${heading}\n## ${version}\n\n- Align the beta version with its companion npm package.\n\n`,
        ),
      );
  }
  command(
    process.execPath,
    [
      resolve(root, 'node_modules/prettier/bin/prettier.cjs'),
      '--write',
      ...VERSION_FILES.filter((file) => file !== '.release/version-plan.json' && existsSync(resolve(cwd, file))),
    ],
    cwd,
  );
  const plan = {
    schema: 2,
    baseSha,
    channel: 'beta',
    cli: '2.29.7',
    package: PUBLIC_PACKAGES[0],
    packages: PUBLIC_PACKAGES,
    previousVersion,
    version,
    changesets,
  };
  writeFileSync(resolve(cwd, '.release/version-plan.json'), `${JSON.stringify(plan, undefined, 2)}\n`);
  for (const name of PUBLIC_PACKAGES)
    for (const file of ['CHANGELOG.md', 'CHANGELOG.zh-CN.md'])
      releaseChapter(readFileSync(resolve(cwd, `packages/${name}/${file}`), 'utf8'), version);
  return plan;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  output('pending', pendingChangesets().length > 0);
