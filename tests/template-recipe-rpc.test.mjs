import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalTemplateStore } from '../src/official/local-template-store.mjs';
import { createTemplateRecipeRpc } from '../src/studio/template-recipe-rpc.mjs';
import { filmHtml, readFilmFile } from '../vendor/film-doc.mjs';
import { writeRecipeZip } from '../src/film/recipe-zip.mjs';
import { createHash } from 'node:crypto';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'no996-recipe-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), library = join(root, 'library');
  await mkdir(join(project, 'pages'), { recursive: true });
  await writeFile(join(project, 'pages', 'one.html'), '<body><h1 data-element-id="headline">Private script</h1></body>');
  await writeFile(join(project, 'pages', 'two.html'), '<body><p>Other scene</p></body>');
  await writeFile(join(project, 'film.html'), filmHtml({ stage: { w: 1080, h: 1920 }, tracks: [{ clips: [
    { id: 'one', title: 'One', src: 'pages/one.html', time: [0, 2] }, { id: 'two', title: 'Two', src: 'pages/two.html', time: [0, 3], at: 2 },
  ] }] }));
  let prefs = { templateMarket: { url: '', refreshedAt: '', items: [] } };
  const rpc = createTemplateRecipeRpc({ store: createLocalTemplateStore({ root: library }),
    preferences: { get: async () => prefs, set: async patch => (prefs = { ...prefs, ...patch }) },
    verifyProject: async id => { if (id !== 'project-id') throw new Error('wrong project'); return { projectId: id, path: project }; },
    projectParent: context => { assert.equal(context, options.projectContext); return root; },
    createProject: async (path, context) => { assert.equal(context, options.projectContext); return { id: 'created-id', path }; },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return { rpc, project, root, prefs };
}

test('preview is project-scoped, single-use and stale after a saved film change', async t => {
  const { rpc, project } = await fixture(t);
  await assert.rejects(rpc('template:recipe-preview', { projectId: 'wrong' }), /wrong project/);
  const preview = await rpc('template:recipe-preview', { projectId: 'project-id' });
  assert.equal(preview.clips.length, 2);
  assert.ok(preview.previewToken);
  await assert.rejects(rpc('template:recipe-save', { projectId: 'project-id', previewToken: preview.previewToken, selected: ['one'], title: 'Test' }), /RECIPE_INPUT|RECIPE_SELECTION/);
  const saved = await rpc('template:recipe-save', { projectId: 'project-id', previewToken: preview.previewToken, selected: ['one'], title: 'Test', description: '' });
  assert.ok(saved.id.startsWith('local-'));
  await assert.rejects(rpc('template:recipe-save', { projectId: 'project-id', previewToken: preview.previewToken, selected: ['one'], title: 'Test', description: '' }), { code: 'RECIPE_PREVIEW_STALE' });
  const next = await rpc('template:recipe-preview', { projectId: 'project-id' });
  await writeFile(join(project, 'film.html'), filmHtml({ stage: { w: 1920, h: 1080 }, tracks: [] }));
  await assert.rejects(rpc('template:recipe-save', { projectId: 'project-id', previewToken: next.previewToken, selected: ['one'], title: 'Test', description: '' }), { code: 'RECIPE_PREVIEW_STALE' });
});

test('local export/import/create use only the recipe and register a fresh project', async t => {
  const projectContext = { name: 'active Studio proxy' };
  const { rpc, root } = await fixture(t, { projectContext });
  const preview = await rpc('template:recipe-preview', { projectId: 'project-id' });
  const { id } = await rpc('template:recipe-save', { projectId: 'project-id', previewToken: preview.previewToken, selected: ['one'], title: 'Test', description: '' });
  assert.equal((await rpc('template:local-list')).templates.length, 1);
  const exported = await rpc('template:local-export', { id });
  await rpc('template:local-delete', { id });
  await rpc('template:local-import', { zipBase64: exported.zipBase64 });
  const created = await rpc('template:local-create', { id, ratio: '9:16' }, projectContext);
  assert.equal(created.projectId, 'created-id');
  const film = readFilmFile(await readFile(join(root, filmPath(root), 'film.html'), 'utf8'));
  assert.deepEqual(film.problems, []);
  assert.deepEqual(film.doc.stage, { w: 1080, h: 1920 });
  assert.equal(film.doc.tracks[0].clips.length, 1);
  const html = await readFile(join(root, filmPath(root), 'pages/one.html'), 'utf8');
  assert.doesNotMatch(html, /Private script/);
  assert.match(html, /data-element-id="headline"/);
});

test('market refresh is data-only and install verifies the indexed hash before saving', async t => {
  const source = await fixture(t);
  const preview = await source.rpc('template:recipe-preview', { projectId: 'project-id' });
  const saved = await source.rpc('template:recipe-save', { projectId: 'project-id', previewToken: preview.previewToken, selected: ['one'], title: 'Market recipe', description: '' });
  const zip = writeRecipeZip(await source.rpc('template:local-get', { id: saved.id }).then(value => value.recipe));
  const sha256 = createHash('sha256').update(zip).digest('hex');
  let mode = 'index';
  const fetchImpl = async url => {
    if (url === 'https://market.test/index.json') {
      if (mode === 'bad-index') return new Response('<script>alert(1)</script>');
      return new Response(JSON.stringify({ version: 1, templates: [{ id: saved.id, title: 'Market recipe', description: '<img src=x>', url: 'https://market.test/recipe.zip', sha256 }] }));
    }
    assert.equal(url, 'https://market.test/recipe.zip');
    return new Response(mode === 'bad-zip' ? Buffer.from('corrupt') : zip);
  };
  const { rpc } = await fixture(t, { fetchImpl });
  await assert.rejects(rpc('template:market-set', { url: 'http://market.test/index.json' }), { code: 'RECIPE_MARKET' });
  await assert.rejects(rpc('template:market-set', { url: 'https://user:secret@market.test/index.json' }), { code: 'RECIPE_MARKET' });
  await rpc('template:market-set', { url: 'https://market.test/index.json' });
  const refreshed = await rpc('template:market-refresh');
  assert.equal(refreshed.market.items.length, 1);
  assert.match(refreshed.market.items[0].description, /<img src=x>/, 'index text is inert data');
  await rpc('template:market-install', { id: saved.id });
  assert.equal((await rpc('template:local-list')).templates.length, 1);
  mode = 'bad-zip';
  await assert.rejects(rpc('template:market-install', { id: saved.id }), { code: 'RECIPE_MARKET_HASH' });
  mode = 'bad-index';
  await assert.rejects(rpc('template:market-refresh'), { code: 'RECIPE_MARKET_UNAVAILABLE' });
});

function filmPath(root) {
  // The test project parent has exactly one newly created template directory.
  return readdirSync(root).find(name => name.startsWith('Test-'));
}
