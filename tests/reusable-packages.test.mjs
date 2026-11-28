import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import Motion, * as motion from '../packages/no996-motion-runtime/src/index.mjs';
import { captionState, cornerBox, createFilmRuntime, localRef, page, safeArea, shotWall, subtitleLayer, textLayer, updateCaptions } from '../packages/no996-scene-kit/src/index.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('motion package keeps every legacy export and the browser global deterministic', () => {
  const legacy = {};
  runInNewContext(read('../vendor/templates/_kit/motion/motion.js'), { window: legacy });
  assert.deepEqual(Object.keys(motion).sort(), [...Object.keys(legacy.Motion), 'default'].sort());
  for (const name of Object.keys(legacy.Motion)) assert.equal(typeof motion[name], 'function', name);
  const browser = {};
  runInNewContext(read('../packages/no996-motion-runtime/browser/no996-motion.js'), { window: browser });
  const outcome = fn => {
    try {
      const value = fn(0.4, 0.6);
      return { value: value === undefined ? '__undefined__' : JSON.parse(JSON.stringify(value)) };
    }
    catch (error) { return { error: error.name }; }
  };
  for (const [name, fn] of Object.entries(motion)) {
    if (name === 'default') continue;
    assert.deepEqual(outcome(browser.No996Motion[name]), outcome(fn), name);
  }
  assert.equal(Motion.spring(0.6), motion.spring(0.6));
  const samples = [0.1, 0.8, 2].map(t => motion.spring(t));
  assert.deepEqual([2, 0.8, 0.1].map(t => motion.spring(t)), [...samples].reverse());
});

test('scene package escapes text, validates cue timing and rejects non-local assets', () => {
  const layer = textLayer({ id: 'headline', tag: 'h1', text: '<img src=x onerror=alert(1)>' });
  assert.match(layer, /&lt;img/);
  assert.doesNotMatch(layer, /<img/);
  assert.throws(() => textLayer({ id: 'bad id', text: 'x' }), /IDs/);
  const cues = [{ id: 'caption-1', text: 'One', fromMs: 0, toMs: 1000 }, { id: 'caption-2', text: 'Two', fromMs: 1000, toMs: 2000 }];
  assert.match(subtitleLayer(cues), /data-from="1000" data-to="2000"/);
  assert.equal(captionState(cues, 1000).id, 'caption-2');
  assert.equal(captionState(cues, 2000), null);
  assert.throws(() => subtitleLayer([{ ...cues[0], toMs: 0 }]), /boundaries/);
  assert.equal(localRef('../assets/kit.css'), '../assets/kit.css');
  for (const value of ['https://example.test/x.js', '/etc/passwd', 'C:/secret', '../..//secret', 'assets/../secret', 'assets\\x']) assert.throws(() => localRef(value), /Unsafe/, value);
  const html = page({ title: '<Title>', size: [1080, 1920], styles: ['../assets/kit.css'], body: layer });
  assert.match(html, /<title>&lt;Title&gt;<\/title>/);
  assert.match(html, /href="..\/assets\/kit.css"/);
});

test('safe areas and film runtime use only the supplied time', async () => {
  assert.deepEqual(safeArea([1080, 1920]), { x: 76, y: 76, w: 928, h: 1768 });
  assert.deepEqual(cornerBox([1920, 1080], { w: 200, h: 100 }, 'bottom-right'), { x: 1644, y: 904, w: 200, h: 100 });
  const drawn = [];
  const root = { document: { fonts: { ready: Promise.resolve() } } };
  const film = createFilmRuntime({ width: 1920, height: 1080, duration: 3, draw: t => drawn.push(t), root });
  await film.ready;
  film.frame(99); film.frame(-1); film.frame(NaN); film.frame(1.25);
  assert.deepEqual(drawn, [0, 3, 0, 0, 1.25]);
  assert.equal(root.film, film);
  const elements = ['caption-1', 'caption-2'].map(id => ({ dataset: { elementId: id }, style: {}, firstElementChild: { style: {} } }));
  const cues = [{ id: 'caption-1', text: 'One', fromMs: 0, toMs: 1000 }, { id: 'caption-2', text: 'Two', fromMs: 1000, toMs: 2000 }];
  assert.equal(updateCaptions(elements, cues, 1200).id, 'caption-2');
  assert.deepEqual(elements.map(item => item.style.visibility), ['hidden', 'visible']);
});

test('shot wall accepts template-authored IDs and preserves audio duration', () => {
  const html = shotWall({ title: 'Demo', size: [1920, 1080], shots: [{ id: 'shot-01', title: 'Intro', start: 0, duration: 3 }],
    audioTracks: [{ id: 'bgm', clips: [{ src: 'assets/music.mp3', at: 0, duration: 2.5, volume: 0.16 }] }] });
  assert.match(html, /src="pages\/shot-01.html#t=0,3" at="0.000"/);
  assert.match(html, /src="assets\/music.mp3#t=0,2.5" at="0.000" volume="0.16"/);
  assert.throws(() => shotWall({ title: 'Bad', shots: [{ id: '"><script>', title: 'x', start: 0, duration: 1 }] }), /IDs/);
});
