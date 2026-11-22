// `no996_film` is the model's map of the film. Two behaviours matter beyond the
// fields it prints: it refuses a conversation that is not bound to a project, and —
// while Studio is open — it warns that an outside write discards the person's
// unsaved overrides (the "edits were undone" banner).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilmTool } from '../src/tools/film-tool.mjs';

const agent = { id: 'a' };
const project = { projectId: 'p1', path: 'C:\\film' };

const tool = (overrides = {}) => createFilmTool({
  isProjectAgent: candidate => candidate === agent,
  projectOf: candidate => (candidate === agent ? project : undefined),
  http: () => ({ get: async () => ({ doc: { tracks: [{ id: 't1', clips: [{ id: 'c1', type: 'video', duration: 2 }] }] }, rev: 'r1' }) }),
  ...overrides,
});

test('a conversation outside a project cannot read a film', async () => {
  const target = tool();
  await assert.rejects(() => target.execute({}, { agent: { id: 'other' } }), /only to a conversation bound/);
});

test('the film summary says Studio is open and that an outside write loses unsaved edits', async () => {
  const live = await tool({ studioRunning: () => true }).execute({}, { agent });
  assert.match(live.text, /Studio 正在运行/);
  assert.match(live.text, /未保存的编排失效/);
  assert.match(live.text, /no996_clip \/ no996_draft/);

  const idle = await tool({ studioRunning: () => false }).execute({}, { agent });
  assert.doesNotMatch(idle.text, /Studio 正在运行/);
});

test('exports and the editable gate keep their own answers', async () => {
  const target = tool({ studioRunning: () => true });
  const exports = await target.execute({ detail: 'exports' }, { agent });
  assert.match(exports.text, /导出能力与落点/);
  assert.doesNotMatch(exports.text, /Studio 正在运行/, 'the warning belongs to the film summary only');
  const editable = await target.execute({ detail: 'editable' }, { agent });
  assert.match(editable.text, /可编辑成片检查/);
});
