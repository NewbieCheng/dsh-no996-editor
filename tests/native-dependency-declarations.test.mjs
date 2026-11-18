// A local `file:` install makes pnpm install our dependencies from package.json
// and prune node_modules trees it did not ask for. The bundled OpenFilm must
// therefore have every one of its own runtime dependencies declared here too —
// missing `playwright-core` once left Studio unable to start (HTTP 503 /
// STUDIO_START) after a local debug install.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

test('every runtime dependency of the bundled OpenFilm is declared here', () => {
  const ours = read('package.json');
  const openfilm = read('node_modules/openfilm/package.json');
  const declared = { ...(ours.dependencies || {}), ...(ours.optionalDependencies || {}) };
  const missing = Object.entries(openfilm.dependencies || {})
    .filter(([name]) => !declared[name])
    .map(([name, version]) => `${name}@${version}`);
  assert.deepEqual(missing, [], `package.json must declare ${missing.join(', ')} so a local install can start Studio`);
});

test('the declared playwright matches the version OpenFilm asks for', () => {
  const ours = read('package.json');
  const openfilm = read('node_modules/openfilm/package.json');
  assert.equal(ours.dependencies['playwright-core'], openfilm.dependencies['playwright-core']);
  assert.equal(ours.bundledDependencies.includes('openfilm'), true);
});
