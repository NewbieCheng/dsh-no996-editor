#!/usr/bin/env node
// Published-package metadata gate.
//
// DSH's plugin version screen decides installability from `pnpm view <name>@<version>`,
// whose VERSION_FIELDS include `dsh`. GitLab's npm registry does NOT persist custom
// manifest fields such as `dsh` or `description`: npm sends the full manifest, but the
// stored version record keeps only name/version/dist/engines/dependencies/devDependencies.
// Consequently a GitLab-published bundle always looks like "no bundle declared" in the
// GUI. This script makes that fact explicit so nobody mistakes it for a broken package
// or tries to "fix" it by editing package.json or republishing the same version.
//
// Exit 0 means the release package itself is sound. It prints a REGISTRY-GUI warning
// when the registry dropped `dsh`; CLI installs are unaffected because they read the
// complete package.json from the tarball.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = pkg.name;
const version = pkg.version;
const registry = String(pkg.publishConfig?.registry || '').replace(/\/$/, '');
if (!registry) throw new Error('publishConfig.registry is missing');

const problems = [];
if (!pkg.dsh?.bundle?.patch) problems.push('source package.json has no dsh.bundle.patch');
if (pkg.dsh.bundle.patch !== './cordis.patch.yml') problems.push(`unexpected dsh.bundle.patch: ${pkg.dsh.bundle.patch}`);
if (!pkg.dsh?.manifestVersion) problems.push('source package.json has no dsh.manifestVersion');

let registryDsh = null;
let packumentError = null;
try {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} (package not published yet?)`);
  const packument = await response.json();
  registryDsh = packument?.versions?.[version]?.dsh?.bundle?.patch ?? null;
} catch (error) {
  packumentError = error instanceof Error ? error.message : String(error);
}

console.log(`package: ${name}@${version}`);
console.log(`source  dsh.bundle.patch: ${pkg.dsh?.bundle?.patch ?? '<missing>'}`);
if (packumentError) console.log(`registry lookup failed: ${packumentError}`);
else console.log(`registry dsh.bundle.patch: ${registryDsh ?? '<missing>'}`);

if (problems.length) {
  console.error(`RELEASE-PACKAGE problems: ${problems.join('; ')}`);
  process.exitCode = 1;
} else if (registryDsh === null) {
  console.log('REGISTRY-GUI: this registry does not persist dsh metadata; the GUI will report');
  console.log('  "这个版本没有声明组合包，无法安装". The package is intact. Install/update with');
  console.log(`  dsh plugin --profile desktop add ${name}@${version}; do not edit package.json or republish.`);
} else {
  console.log('REGISTRY-GUI: dsh bundle declaration present; GUI install/update should work.');
}
