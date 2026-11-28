import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { readFilmFile, parseFilm, filmHtml, clipSpan } from 'openfilm/film-doc';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/templates');
const cases = [
  { name: 'vibe-explainer', stage: [1080, 1920], lengths: [5, 5, 6, 5.5, 5.5, 5.5, 5, 4.5], duration: 42, hasAudio: true },
  { name: 'vibe-explainer', entry: 'film-landscape.html', pages: 'pages-landscape', stage: [1920, 1080], lengths: [5, 5, 6, 5.5, 5.5, 5.5, 5, 4.5], duration: 42, hasAudio: true },
  { name: 'paper-texture', stage: [1080, 1920], lengths: [6, 7], duration: 13 },
  { name: 'paper-texture', entry: 'film-landscape.html', pages: 'pages-landscape', stage: [1920, 1080], lengths: [6, 7], duration: 13 },
  { name: 'sketchnote', stage: [1080, 1920], lengths: [2.756, 2.744, 3.383, 3.679, 3.859, 1.472, 2.051], duration: 19.944 },
  { name: 'sketchnote', entry: 'film-landscape.html', pages: 'pages-landscape', stage: [1920, 1080], lengths: [2.756, 2.744, 3.383, 3.679, 3.859, 1.472, 2.051], duration: 19.944 },
  { name: 'motion-styles', stage: [1080, 1920], lengths: [10, 8], duration: 18 },
  { name: 'motion-styles', entry: 'film-landscape.html', pages: 'pages-landscape', stage: [1920, 1080], lengths: [10, 8], duration: 18 },
];

test('paper still pages expose the OpenFilm frame contract', async () => {
  for (const [name, duration] of [['shot-01', 6], ['shot-02', 7]]) {
    const html = await readFile(resolve(root, 'paper-texture', 'pages', `${name}.html`), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    const window = {};
    const ready = Promise.resolve();
    runInNewContext(scripts[0][1], { window, document: { fonts: { ready } } });
    assert.equal(window.film.width, 1080);
    assert.equal(window.film.height, 1920);
    assert.equal(window.film.duration, duration);
    await window.film.ready;
    for (const t of [0, duration - 0.01, 1, 0]) assert.doesNotThrow(() => window.film.frame(t));
  }
});

for (const { name, entry = 'film.html', pages = 'pages', stage, lengths, duration, hasAudio } of cases) {
  test(`${name}/${entry}: official film parser, format and referenced clips`, async () => {
    const dir = resolve(root, name);
    const source = await readFile(resolve(dir, entry), 'utf8');
    const result = readFilmFile(source);
    assert.deepEqual(result.problems, []);
    assert.ok(result.doc);
    const doc = parseFilm(result.value);
    assert.deepEqual(doc, result.doc);
    assert.deepEqual([doc.stage.w, doc.stage.h], stage);
    if (hasAudio) {
      assert.ok(doc.tracks.length >= 2, `${name} ships non-overlapping SFX tracks`);
      for (const audioTrack of doc.tracks.slice(1)) {
        for (const clip of audioTrack.clips) await readFile(resolve(dir, clip.src));
      }
    } else {
      assert.equal(doc.tracks.length, 1);
    }
    const clips = doc.tracks[0].clips;
    assert.equal(clips.length, lengths.length);
    let endMs = 0;
    for (const [i, clip] of clips.entries()) {
      assert.equal(clip.id, `shot-${String(i + 1).padStart(2, '0')}`);
      assert.equal(clip.src, `${pages}/${clip.id}.html`);
      assert.equal(Math.round(clip.at * 1000), endMs, `${clip.id} start`);
      const span = clipSpan(clip);
      assert.equal(span.from, 0);
      assert.equal(Math.round(span.length * 1000), Math.round(lengths[i] * 1000), `${clip.id} length`);
      endMs += Math.round(span.length * 1000);
      await readFile(resolve(dir, clip.src));
    }
    assert.equal(endMs, Math.round(duration * 1000));
    const roundTrip = readFilmFile(filmHtml(result.value, source));
    assert.deepEqual(roundTrip.problems, []);
    assert.deepEqual(roundTrip.doc, doc);
  });
}
