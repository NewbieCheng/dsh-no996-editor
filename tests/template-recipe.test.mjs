import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { filmHtml, readFilmFile } from '../vendor/film-doc.mjs';
import { extractRecipe, normalizeRecipe, recipeProjectFiles, shareRecipe } from '../src/film/template-recipe.mjs';
import { sanitizeRecipeScene } from '../src/film/recipe-html.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=', 'base64');
const scene = `<body><style>.card{position:absolute;left:8%;top:20%;color:#214f42}</style><main><h1 data-element-id="headline">Private script sentence</h1><div class="card"><img data-element-id="picture" src="../assets/photo.png"><script>fetch('https://bad.test')</script><button onclick="steal()">Private button</button></div></main></body>`;

test('scene sanitizer keeps editable structure but removes scripts, events and private copy', () => {
  const safe = sanitizeRecipeScene(scene, { prefix: 'shot-01' });
  assert.match(safe.html, /data-element-id="headline"/);
  assert.match(safe.html, /\{\{headline\}\}/);
  assert.match(safe.html, /assets\/shot-01-0\.png/);
  assert.doesNotMatch(safe.html, /Private script|<script|onclick|fetch\(/);
  assert.equal(Object.keys(safe.labels).length, 2);
});

test('extraction reads only selected page files and direct image dependencies', async () => {
  const film = { doc: readFilmFile(filmHtml({ stage: { w: 1080, h: 1920 }, tracks: [{ clips: [
    { id: 'chosen', src: 'pages/chosen.html', time: [0, 3], at: 0 },
    { id: 'other', src: 'pages/other.html', time: [0, 4], at: 3 },
  ] }] })).doc };
  const reads = [];
  const recipe = await extractRecipe({ film, projectPath: '/project', selected: ['chosen'], title: 'My recipe',
    readLocal: async path => { reads.push(path); return path === 'pages/chosen.html' ? Buffer.from(scene) : path === 'assets/photo.png' ? png : path === 'assets/audio/music.mp3' ? Buffer.from('audio-fixture') : path === 'assets/brand/logo.png' ? Buffer.concat([png, Buffer.from('logo')]) : assert.fail(`unexpected read ${path}`); },
    brand: { mode: 'snapshot', enabled: true, name: 'Brand', placement: 'top-left', logo: { path: 'assets/brand/logo.png' } },
    bgm: { path: 'assets/audio/music.mp3', volume: 0.2, duration: 8, beats: [0, 500] },
  });
  assert.deepEqual(reads, ['pages/chosen.html', 'assets/photo.png', 'assets/audio/music.mp3', 'assets/brand/logo.png']);
  assert.equal(recipe.scenes.length, 1);
  assert.equal(recipe.scenes[0].duration, 3);
  assert.equal(recipe.assets.length, 3);
  assert.doesNotMatch(recipe.scenes[0].html, /Private script/);
  assert.deepEqual(normalizeRecipe(recipe), recipe);
});

test('the brand lockup the app writes itself is never offered or extracted as a reusable scene', async () => {
  const film = { doc: readFilmFile(filmHtml({ stage: { w: 1080, h: 1920 }, tracks: [{ clips: [
    { id: 'chosen', src: 'pages/chosen.html', time: [0, 2], at: 0 },
    { id: 'no996-project-logo', src: `assets/brand/lockup-${'a'.repeat(64)}.html`, time: [0, 2], at: 0 },
  ] }] })).doc };
  const recipe = await extractRecipe({ film, projectPath: '/project', selected: ['chosen'], title: 'Scene only',
    readLocal: async path => path === 'pages/chosen.html' ? Buffer.from(scene) : path === 'assets/photo.png' ? png : assert.fail(`unexpected read ${path}`) });
  assert.equal(recipe.scenes.length, 1);
  await assert.rejects(extractRecipe({ film, projectPath: '/project', selected: ['no996-project-logo'], title: 'Brand', readLocal: async () => assert.fail('brand page read') }), { code: 'RECIPE_SELECTION' });
});

test('generated project is self-contained and share strips private brand and music by default', () => {
  const base = normalizeRecipe({ version: 1, id: 'sample-recipe', title: 'Sample', description: '', canvas: { w: 1920, h: 1080, ratio: '16:9' },
    scenes: [{ id: 'shot-01', title: 'Intro', duration: 2, html: '<h1 data-element-id="headline">{{headline}}</h1>', labels: { headline: '{{headline}}' }, assets: {} }],
    assets: [{ path: 'assets/music.mp3', sha256: 'a'.repeat(64), bytes: 4, kind: 'audio' }],
    bgm: { path: 'assets/music.mp3', volume: 0.16, duration: 10, beats: [0, 0.5] },
    brand: { enabled: true, name: 'Private', placement: 'top-left', logo: null },
  });
  const files = recipeProjectFiles(base, { motionRuntime: 'window.Motion={};' });
  const film = readFilmFile(files.get('film.html'));
  assert.deepEqual(film.problems, []);
  assert.equal(film.doc.tracks.length, 2);
  assert.equal(film.doc.tracks[1].clips[0].volume, 0.16);
  assert.match(files.get('pages/shot-01.html'), />\{\{headline\}\}</);
  const shared = shareRecipe(base);
  assert.equal(shared.bgm, undefined);
  assert.equal(shared.brand, undefined);
  assert.equal(shared.assets.length, 0);
  assert.equal(shareRecipe(base, { includeBgm: true }).assets.length, 1);
});

test('recipe rejects non-canonical HTML, path traversal and mismatched canvas', () => {
  const valid = normalizeRecipe({ version: 1, id: 'sample-recipe', title: 'Sample', description: '', canvas: { w: 1080, h: 1920, ratio: '9:16' },
    scenes: [{ id: 'shot-01', title: 'Intro', duration: 2, html: '<h1 data-element-id="headline">{{headline}}</h1>', labels: { headline: 'Title' }, assets: {} }], assets: [] });
  assert.throws(() => normalizeRecipe({ ...valid, scenes: [{ ...valid.scenes[0], html: '<h1 data-element-id="headline" onclick="x()">Title</h1>' }] }), { code: 'RECIPE_HTML_INPUT' });
  assert.throws(() => normalizeRecipe({ ...valid, canvas: { w: 1920, h: 1080, ratio: '9:16' } }), { code: 'RECIPE_INPUT' });
  assert.throws(() => normalizeRecipe({ ...valid, assets: [{ path: 'assets/../x.png', sha256: 'a'.repeat(64), bytes: 1, kind: 'image' }] }), { code: 'RECIPE_INPUT' });
});
