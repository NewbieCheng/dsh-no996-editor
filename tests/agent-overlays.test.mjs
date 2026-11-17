import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PERSONA, ROOT_MARKERS } from '../src/native/openfilm-persona.mjs';
import { instructionChain, projectRootOf } from '../src/native/instruction-inventory.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'no996-instructions-'));

function repoWithFilm() {
  const root = scratch();
  writeFileSync(join(root, 'AGENTS.md'), '# plugin manual\n\nA DSH plugin at version 0.15.x, MIT.\n');
  writeFileSync(join(root, '.git'), 'gitdir: elsewhere\n');
  const film = join(root, 'films', 'Projects', 'demo');
  mkdirSync(join(film, '.film'), { recursive: true });
  writeFileSync(join(film, 'film.html'), '<html></html>\n');
  writeFileSync(join(film, 'AGENTS.md'), '# OpenFilm 项目工作说明\n\n先读再改。\n');
  return { root, film };
}

test('the persona says film director, not coding agent', () => {
  assert.match(PERSONA, /剪辑导演/);
  assert.doesNotMatch(PERSONA, /coding agent/i);
  assert.match(PERSONA, /按需加载 openfilm-motion/);
  assert.ok(Buffer.byteLength(PERSONA, 'utf8') <= 400, `${Buffer.byteLength(PERSONA, 'utf8')} bytes`);
});

test('a film folder inside a repository no longer inherits the repository manual', () => {
  const { root, film } = repoWithFilm();
  const withFilmMarkers = instructionChain({ cwd: film, markers: ROOT_MARKERS });
  assert.equal(withFilmMarkers.root, film, 'the film folder is the root');
  assert.deepEqual(withFilmMarkers.files.map(entry => entry.file), [join(film, 'AGENTS.md')]);
  assert.ok(withFilmMarkers.outside.includes(join(root, 'AGENTS.md')), 'the repository manual is named as excluded');

  const withGitOnly = instructionChain({ cwd: film, markers: ['.git'] });
  assert.equal(withGitOnly.root, root);
  assert.deepEqual(withGitOnly.files.map(entry => entry.file).sort(), [join(root, 'AGENTS.md'), join(film, 'AGENTS.md')].sort());
});

test('the chain is broad to specific and carries sizes', () => {
  const { film } = repoWithFilm();
  const chain = instructionChain({ cwd: film, markers: ROOT_MARKERS, dshHome: join(film, '.dsh'), agentsHome: join(film, '.agents') });
  assert.equal(chain.files.length, 1);
  assert.ok(chain.files[0].bytes > 0);
  assert.equal(chain.files[0].level, 'project-root');
});

test('a missing folder is reported, not thrown', () => {
  assert.deepEqual(instructionChain({ cwd: '' }).files, []);
  assert.deepEqual(instructionChain({}).files, []);
  assert.equal(projectRootOf(join(scratch(), 'nope')), undefined);
});
