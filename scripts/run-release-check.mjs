#!/usr/bin/env node
// Formal release gate. This script never publishes or installs a plugin.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectRepo, gitOutput, releaseProblems } from './release-check.mjs';
import { resolveOfficialShell } from '../src/official/official-shell.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REGISTRY = 'https://registry.npmjs.org/';
const NAME = '@newbiecheng/no996-editor';

export function registryProblems(output, version) {
  let values;
  try { values = JSON.parse(output); } catch { return ['registry returned invalid version metadata']; }
  if (typeof values === 'string') values = [values];
  if (!Array.isArray(values) || values.length === 0 || !values.every(value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value))) {
    return ['registry returned empty or malformed version metadata'];
  }
  return values.includes(version) ? [`${NAME}@${version} already exists in registry`] : [];
}

export function archiveProblems(output) {
  const names = new Set(output.split(/\r?\n/).filter(Boolean).map(name => name.replace(/^\.\//, '')));
  const required = ['package/package.json', 'package/index.js', 'package/client.js', 'package/cordis.patch.yml', 'package/vendor/official-shell/manifest.json', 'package/node_modules/openfilm/package.json', 'package/node_modules/zod/package.json'];
  const problems = required.filter(name => !names.has(name)).map(name => `package is missing ${name}`);
  for (const name of names) {
    if (/(?:^|\/)(?:\.npmrc(?:\..*)?|\.gitlab-npm-token\.tmp|\.git)(?:\/|$)/i.test(name) ||
        name.startsWith('package/films/') ||
        name.startsWith('package/.dev/') ||
        name.startsWith('package/.upstream/') ||
        name.startsWith('package/scripts/') ||
        name.startsWith('package/patches/') ||
        name.startsWith('package/src/dev/') ||
        name === 'package/assets/style-lab.js' ||
        name === 'package/src/ui/style-lab.mjs' ||
        name === 'package/src/studio/studio-debug.mjs' ||
        name === 'package/src/studio/studio-debug-redirect.mjs' ||
        name === 'package/src/studio/studio-controller/routes/debug-url.mjs') {
      problems.push(`package contains prohibited entry ${name}`);
    }
  }
  return problems;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`failed: ${args.join(' ')}`);
}

function npmCli() {
  const path = process.env.npm_execpath;
  if (!path || !path.endsWith('.js')) throw new Error('run via npm run release:check so npm_execpath is available');
  return path;
}

async function main() {
  if (process.argv.length !== 2) throw new Error('formal release gate does not accept overrides');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (pkg.name !== NAME || pkg.publishConfig?.registry !== REGISTRY) throw new Error('unexpected package name or registry');
  const state = inspectRepo();
  const ciTag = process.env.CI === 'true' ? process.env.CI_COMMIT_TAG : '';
  if (ciTag) {
    if (ciTag !== `v${state.version}`) throw new Error('CI tag must match package version');
    const head = gitOutput(['rev-parse', 'HEAD']);
    if (gitOutput(['rev-parse', `refs/tags/${ciTag}^{commit}`]) !== head || (process.env.CI_COMMIT_SHA && process.env.CI_COMMIT_SHA !== head)) throw new Error('CI tag does not identify HEAD');
    state.allowedTag = ciTag;
  }
  const problems = releaseProblems(state);
  if (problems.length) throw new Error(problems.join('; '));
  const npm = npmCli();
  console.log('release: checking registry metadata (network/auth failure stops release)');
  let versions;
  try {
    versions = execFileSync(process.execPath, [npm, 'view', NAME, 'versions', '--json', '--registry', REGISTRY, '--fetch-retries=0', '--fetch-timeout=15000'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  } catch { throw new Error('registry lookup failed; check network and npm credentials'); }
  const registryErrors = registryProblems(versions, state.version);
  if (registryErrors.length) throw new Error(registryErrors.join('; '));
  console.log('release: running complete checks');
  run(process.execPath, [npm, 'run', 'check']);
  run(process.execPath, ['scripts/theme-bake.mjs', '--check']);
  await resolveOfficialShell();
  const temp = mkdtempSync(join(tmpdir(), 'no996-editor-release-check-'));
  try {
    const built = join(temp, 'client.js');
    run(process.execPath, ['scripts/build.mjs', '--outfile', built]);
    if (!readFileSync(built).equals(readFileSync(join(ROOT, 'client.js')))) throw new Error('client.js differs from a fresh build; build and commit it before release');
    run(process.execPath, ['scripts/pack-tgz.mjs', '--out-dir', temp]);
    const archive = join(temp, `newbiecheng-no996-editor-${state.version}.tgz`);
    const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
    const listing = execFileSync(tar, ['-tzf', archive], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const archiveErrors = archiveProblems(listing);
    if (archiveErrors.length) throw new Error(archiveErrors.join('; '));
    const packedPkg = JSON.parse(execFileSync(tar, ['-xOzf', archive, 'package/package.json'], { cwd: ROOT, encoding: 'utf8' }));
    if (packedPkg?.dsh?.releaseBuild !== true) throw new Error('release archive package.json must stamp dsh.releaseBuild = true');
  } finally { rmSync(temp, { recursive: true, force: true }); }
  if (gitOutput(['status', '--porcelain']) !== '') throw new Error('checks changed the working tree');
  console.log(`release:check passed for ${NAME}@${state.version}; nothing was published. GUI verification remains separate.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(`release:check: ${error.message}`); process.exitCode = 1; });
}
