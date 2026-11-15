// Who the film conversation's agent is, and where its instructions stop.
//
// These two overlays are the P0 of docs/topics/agent-plan.md, and they are the
// difference between "a coding agent that happens to have film tools" and a film
// editor: identity from the child's own configuration, and an instruction chain
// that cannot climb into the repository above the film folder.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PERSONA, ROOT_MARKERS, overlayYaml, writeOverlay } from '../src/agent-overlays.mjs';
import { instructionChain, projectRootOf } from '../src/instruction-inventory.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'no996-instructions-'));

/** A repository with a film project inside it, as a checkout of this plugin has. */
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
  // It is an identity, not a manual: a budget, not an essay.
  assert.ok(Buffer.byteLength(PERSONA, 'utf8') <= 400, `${Buffer.byteLength(PERSONA, 'utf8')} bytes`);
});

test('the overlay overrides the persona and makes a film folder its own instruction root', () => {
  const yaml = overlayYaml();
  assert.match(yaml, /- id: system-prompt/);
  assert.match(yaml, /personaPrefix: "/);
  assert.match(yaml, /- id: agent-instructions/);
  assert.match(yaml, /maxBytes: 65536/);
  for (const marker of ROOT_MARKERS) assert.ok(yaml.includes(JSON.stringify(marker)), `${marker} is a marker`);
  assert.ok(ROOT_MARKERS.includes('.film'), 'a film project folder carries .film');
  assert.ok(ROOT_MARKERS.includes('film.html'), 'or the film itself');
});

test('the overlay is written where the child is told to read it', async () => {
  const dir = scratch();
  const file = await writeOverlay({ dir });
  assert.equal(file, join(dir, 'dsh-openfilm-acp-instructions.yml'));
});

test('a film folder inside a repository no longer inherits the repository manual', () => {
  const { root, film } = repoWithFilm();
  const withFilmMarkers = instructionChain({ cwd: film, markers: ROOT_MARKERS });
  assert.equal(withFilmMarkers.root, film, 'the film folder is the root');
  assert.deepEqual(withFilmMarkers.files.map(entry => entry.file), [join(film, 'AGENTS.md')]);
  assert.ok(withFilmMarkers.outside.includes(join(root, 'AGENTS.md')), 'the repository manual is named as excluded');

  // The old marker set is what produced the bug: the chain climbed to the checkout
  // and read the plugin's own manual into the film conversation.
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
