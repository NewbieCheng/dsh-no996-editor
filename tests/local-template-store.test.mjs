import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLocalTemplateStore } from '../src/official/local-template-store.mjs';
import { extractRecipe, normalizeRecipe, RECIPE_ASSET_BYTES } from '../src/film/template-recipe.mjs';
import { readRecipeZip, writeRecipeZip } from '../src/film/recipe-zip.mjs';
import { filmHtml, readFilmFile } from '../vendor/film-doc.mjs';

const bytes = Buffer.from('a small local image fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const recipe = normalizeRecipe({ version: 1, id: 'local-test', title: 'Test recipe', description: 'Only a scene', canvas: { w: 1080, h: 1920, ratio: '9:16' },
  scenes: [{ id: 'shot-01', title: 'Intro', duration: 2, html: `<h1 data-element-id="headline">{{headline}}</h1><img data-element-id="image" src="assets/${sha256}.png">`, labels: { headline: 'Title' }, assets: { [`assets/${sha256}.png`]: `assets/${sha256}.png` } }],
  assets: [{ path: `assets/${sha256}.png`, sha256, bytes: bytes.length, kind: 'image' }] });

async function root(t) { const path = await mkdtemp(join(tmpdir(), 'no996-local-template-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('local library persists only recipe data and required assets', async t => {
  const store = createLocalTemplateStore({ root: join(await root(t), 'library') });
  const value = { ...recipe };
  Object.defineProperty(value, RECIPE_ASSET_BYTES, { value: new Map([[recipe.assets[0].path, bytes]]) });
  await store.save(value);
  assert.deepEqual(await store.list(), [{ id: 'local-test', title: 'Test recipe', description: 'Only a scene', canvas: recipe.canvas, scenes: 1, assets: 1, hasBgm: false, hasBrand: false, source: 'local' }]);
  const loaded = await store.get('local-test');
  assert.deepEqual(loaded[RECIPE_ASSET_BYTES].get(recipe.assets[0].path), bytes);
  assert.deepEqual((await readdir(join(store.root, 'local-test'))).sort(), ['assets', 'recipe.json']);
  await writeFile(join(store.root, 'local-test', 'chat.txt'), 'not allowed');
  assert.equal((await store.list()).length, 1, 'unrelated files are never listed or copied');
  await store.remove('local-test');
  assert.deepEqual(await store.list(), []);
});

test('share ZIP round-trips data and rejects traversal, scripts and corrupt assets', async t => {
  const value = { ...recipe };
  Object.defineProperty(value, RECIPE_ASSET_BYTES, { value: new Map([[recipe.assets[0].path, bytes]]) });
  const zip = writeRecipeZip(value);
  const loaded = readRecipeZip(zip);
  assert.deepEqual(loaded, recipe);
  assert.deepEqual(loaded[RECIPE_ASSET_BYTES].get(recipe.assets[0].path), bytes);
  const corrupt = Buffer.from(zip);
  corrupt[corrupt.length - 30] ^= 1;
  assert.throws(() => readRecipeZip(corrupt));
  assert.throws(() => writeRecipeZip({ ...value, scenes: [{ ...value.scenes[0], html: '<h1 data-element-id="x">{{x}}</h1><img data-element-id="i" src="assets/../secret.png">', labels: { x: 'X' }, assets: { 'assets/../secret.png': `assets/${sha256}.png` } }] }));
});

test('extraction inlines directly referenced CSS and keeps its local images', async t => {
  const dir = await root(t);
  await mkdir(join(dir, 'pages')); await mkdir(join(dir, 'assets'));
  await writeFile(join(dir, 'pages', 'one.html'), '<html><head><link rel="stylesheet" href="../assets/kit.css"></head><body><h1 data-element-id="title">Private</h1><div class="card">Card</div></body></html>');
  await writeFile(join(dir, 'assets', 'kit.css'), '.card{position:absolute;left:8%;background-image:url("texture.png")}');
  await writeFile(join(dir, 'assets', 'texture.png'), bytes);
  await writeFile(join(dir, 'film.html'), filmHtml({ stage: { w: 1080, h: 1920 }, tracks: [{ clips: [{ id: 'one', src: 'pages/one.html', time: [0, 2] }] }] }));
  const film = readFilmFile(await readFile(join(dir, 'film.html'), 'utf8'));
  const reads = [];
  const recipe = await extractRecipe({ film, projectPath: dir, selected: ['one'], title: 'CSS recipe', readLocal: async path => { reads.push(path); return readFile(join(dir, path)); } });
  assert.deepEqual(reads, ['pages/one.html', 'assets/kit.css', 'assets/texture.png']);
  assert.match(recipe.scenes[0].html, /<style>\.card\{position: absolute; left: 8%; background-image: url\("assets\/[a-f0-9]{64}\.png"\)\}/);
  assert.doesNotMatch(recipe.scenes[0].html, /Private|href="\.\.\/assets/);
  assert.equal(recipe.assets.length, 1);
});

test('extraction never walks the project or reads unselected clips', async t => {
  const dir = await root(t);
  await mkdir(join(dir, 'pages'));
  await writeFile(join(dir, 'pages', 'one.html'), '<body><h1 data-element-id="title">Private words</h1></body>');
  await writeFile(join(dir, 'pages', 'two.html'), 'SECRET');
  await writeFile(join(dir, 'film.html'), filmHtml({ stage: { w: 1080, h: 1920 }, tracks: [{ clips: [
    { id: 'one', src: 'pages/one.html', time: [0, 2] }, { id: 'two', src: 'pages/two.html', time: [0, 2], at: 2 },
  ] }] }));
  const film = readFilmFile(await readFile(join(dir, 'film.html'), 'utf8'));
  const reads = [];
  const value = await extractRecipe({ film, projectPath: dir, selected: ['one'], title: 'Selected', readLocal: async path => { reads.push(path); return readFile(join(dir, path)); } });
  assert.deepEqual(reads, ['pages/one.html']);
  assert.doesNotMatch(value.scenes[0].html, /Private words/);
  assert.equal(value.scenes.length, 1);
});
