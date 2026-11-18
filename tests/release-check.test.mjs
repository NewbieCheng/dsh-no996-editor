// Release rules are cheap to state and easy to forget, so they are pure functions
// with tests instead of prose in a playbook. Each case here is a mistake that has
// either happened in this repo (stale lockfile version, missing changelog entry) or
// is one commit away from happening (releasing a version whose tag already exists).
import assert from 'node:assert/strict';
import test from 'node:test';
import { gitOutput, releaseProblems } from '../scripts/release-check.mjs';
import { archiveProblems, registryProblems } from '../scripts/run-release-check.mjs';

const base = {
  version: '0.15.1',
  changelog: '## 0.15.1 —— 收口\n\n- x\n',
  statusText: '| 仓库版本 | **0.15.1**（`package.json`） |',
  tags: ['v0.12.1'],
  dirty: false,
  lockVersion: '0.15.1',
};

test('git failure blocks release instead of pretending the tree is clean', () => {
  assert.throws(() => gitOutput(['status', '--porcelain'], () => { throw new Error('unavailable'); }), /release check stopped/);
  assert.equal(gitOutput(['status', '--porcelain'], () => ''), '');
});

test('a ready tree has no problems', () => {
  assert.deepEqual(releaseProblems(base), []);
});

test('a dirty tree blocks the release unless explicitly allowed', () => {
  assert.ok(releaseProblems({ ...base, dirty: true }).some(line => line.includes('not clean')));
});

test('a stale lockfile version blocks the release', () => {
  assert.ok(releaseProblems({ ...base, lockVersion: '0.13.4' }).some(line => line.includes('package-lock.json')));
});

test('a missing changelog section blocks the release', () => {
  assert.ok(releaseProblems({ ...base, changelog: '## 0.15.0 —— old\n' }).some(line => line.includes('CHANGELOG.md')));
});

test('a version that does not appear in STATE blocks the release', () => {
  assert.ok(releaseProblems({ ...base, statusText: '| 仓库版本 | **0.15.0** |' }).some(line => line.includes('STATE.md')));
});

test('an existing tag blocks the release', () => {
  assert.ok(releaseProblems({ ...base, tags: ['v0.15.1'] }).some(line => line.includes('tag v0.15.1')));
});

test('CI may permit its verified matching tag, but not a different one', () => {
  assert.deepEqual(releaseProblems({ ...base, tags: ['v0.15.1'], allowedTag: 'v0.15.1' }), []);
  assert.ok(releaseProblems({ ...base, tags: ['v0.15.1'], allowedTag: 'v0.15.0' }).length);
});

test('registry metadata must be valid, readable, and not include the version', () => {
  assert.deepEqual(registryProblems('["0.15.0"]', '0.15.1'), []);
  for (const value of ['[]', '{}', 'not json', '["0.15.1"]']) assert.ok(registryProblems(value, '0.15.1').length);
});

test('release archive requires entry points and bundled runtime but excludes secrets and dev tooling', () => {
  const good = ['package/package.json', 'package/index.js', 'package/client.js', 'package/cordis.patch.yml', 'package/vendor/official-shell/manifest.json', 'package/node_modules/openfilm/package.json', 'package/node_modules/zod/package.json'].join('\n');
  assert.deepEqual(archiveProblems(good), []);
  assert.ok(archiveProblems(good.replace('package/client.js', '')).length);
  assert.ok(archiveProblems(good + '\npackage/.npmrc').length);
  assert.ok(archiveProblems(good + '\npackage/films/film.html').length);
  assert.ok(archiveProblems(good + '\npackage/src/dev/dev-hmr-proxy.mjs').length);
  assert.ok(archiveProblems(good + '\npackage/scripts/dev-live.mjs').length);
  assert.ok(archiveProblems(good + '\npackage/patches/series.json').length);
  assert.ok(archiveProblems(good + '\npackage/assets/style-lab.js').length);
  assert.ok(archiveProblems(good + '\npackage/src/studio/studio-debug.mjs').length);
});

test('missing release metadata blocks instead of being treated as verified', () => {
  assert.ok(releaseProblems({ ...base, changelog: null }).some(line => line.includes('CHANGELOG.md')));
  assert.ok(releaseProblems({ ...base, statusText: null }).some(line => line.includes('STATE.md')));
  assert.ok(releaseProblems({ ...base, lockVersion: null }).some(line => line.includes('package-lock.json')));
});
