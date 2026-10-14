import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Validate the branch, version, and tag before publishing an experimental release. */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
const tag = process.env.npm_config_tag || pkg.publishConfig?.tag;
if (branch !== 'v2' || !/^2\.\d+\.\d+-(alpha|beta|rc)\.\d+$/.test(pkg.version) || tag !== 'next') {
  throw new Error('Experiments must be published from v2 with a 2.x.x-alpha/beta/rc.N version and the next tag.');
}
