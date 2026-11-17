#!/usr/bin/env node
// Fast, conservative development feedback; never a replacement for npm run check.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const normalize = path => path.replace(/\\/g, '/');

export function relatedTests(root, changed) {
  const testsDir = join(root, 'tests');
  const tests = readdirSync(testsDir).filter(name => name.endsWith('.test.mjs')).sort();
  const wanted = new Set(changed.map(normalize));
  const cache = new Map();
  function dependencies(file, seen = new Set()) {
    if (seen.has(file)) return seen;
    seen.add(file);
    if (!existsSync(file)) return seen;
    if (!cache.has(file)) {
      const text = readFileSync(file, 'utf8');
      const imports = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])(\.[^'"]+)\1/g)]
        .map(match => resolve(dirname(file), match[2]))
        .filter(path => ['.js', '.mjs'].includes(extname(path)));
      cache.set(file, imports);
    }
    for (const dep of cache.get(file)) dependencies(dep, seen);
    return seen;
  }
  return tests.filter(name => {
    const testPath = `tests/${name}`;
    if (wanted.has(testPath)) return true;
    const base = name.slice(0, -'.test.mjs'.length);
    if ([...wanted].some(path => path === `scripts/${base}.mjs` || path === `src/${base}.mjs`)) return true;
    return [...dependencies(join(testsDir, name))].some(file => wanted.has(normalize(relative(root, file))));
  }).map(name => `tests/${name}`);
}

function main() {
  let changed;
  try {
    const opts = { cwd: ROOT, encoding: 'utf8' };
    const unstaged = execFileSync('git', ['ls-files', '-m', '-o', '--exclude-standard', '-z'], opts);
    const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], opts);
    changed = [...new Set(`${unstaged}\0${staged}`.split('\0').filter(Boolean))];
  } catch {
    throw new Error('Cannot determine changed files; use npm run check.');
  }
  const run = args => {
    const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Quick check failed: ${args.join(' ')}`);
  };
  run(['scripts/lint.mjs', '--strict', '--changed']);
  run(['scripts/status-check.mjs']);
  const tests = relatedTests(ROOT, changed);
  if (tests.length) {
    console.log(`quick: running ${tests.length} directly related test files: ${tests.join(', ')}`);
    run(['--test', ...tests]);
  } else console.log('quick: no related tests identified; none were run.');
  console.log('quick: dependency matching is best-effort; dynamic, integration and unrelated tests, full syntax, docs, brand, templates, patches, build and release checks were NOT all run. Run npm run check before commit.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main(); } catch (error) { console.error(`quick: ${error.message}`); process.exitCode = 1; }
}
