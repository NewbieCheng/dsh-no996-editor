import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { renderVibeScene } from '../vendor/templates/_kit/vibe/editable-page.mjs';
import { inspectPageEditableLayers } from '../src/film/editable-check.mjs';

const asset = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const shot = JSON.parse(asset('../vendor/templates/vibe-explainer/shots/shot-01.json'));
const motion = asset('../vendor/templates/_kit/motion/motion.js');

for (const [orientation, [width, height]] of [['portrait', [1080, 1920]], ['landscape', [1920, 1080]]]) {
  test(`Vibe opener ${orientation} has native dimensions and separately editable text and diagram`, async () => {
    const html = renderVibeScene(shot, [width, height]);
    assert.match(html, new RegExp(`<main class="vibe-page ${orientation}">`));
    const editable = inspectPageEditableLayers(html);
    assert.equal(editable.canvasCount, 0);
    assert.deepEqual(editable.duplicateElementIds, []);
    for (const layer of ['vibe-headline', 'vibe-deck', 'vibe-subtitle', 'vibe-diagram', 'vibe-callout']) {
      assert.equal(editable.elements.filter(item => item.elementId === layer).length, 1, layer);
    }
    const nodes = new Map();
    const window = {};
    const nodeOf = key => {
      const attributes = {};
      const node = { style: {}, attributes, firstElementChild: { style: {} }, setAttribute: (name, value) => { attributes[name] = value; } };
      nodes.set(key, node);
      return node;
    };
    const context = { window, document: { fonts: { ready: Promise.resolve() }, querySelector: nodeOf,
      querySelectorAll: key => key === '[data-caption]' ? [nodeOf('line-1'), nodeOf('line-2')] : [],
    } };
    const code = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    runInNewContext(motion, context);
    runInNewContext(code, context);
    await window.film.ready;
    assert.equal(window.film.width, width);
    assert.equal(window.film.height, height);
    assert.equal(window.film.duration, shot.duration);
    const draw = t => {
      window.film.frame(t);
      return JSON.stringify([...nodes].map(([id, node]) => [id, node.style, node.attributes]));
    };
    const settled = draw(3);
    assert.notEqual(draw(0.12), settled);
    assert.equal(draw(3), settled, 'seeking backwards and forwards is deterministic');
    assert.equal(draw(99), draw(shot.duration));
  });
}

test('both generated films keep all eight scenes and share no opposite-ratio page references', () => {
  const base = '../vendor/templates/vibe-explainer/';
  for (const [entry, pages, layout, size] of [
    ['film.html', 'pages', 'portrait', [1080, 1920]],
    ['film-landscape.html', 'pages-landscape', 'landscape', [1920, 1080]],
  ]) {
    const film = asset(base + entry);
    assert.ok(film.includes(`width=${size[0]}, height=${size[1]}`));
    const clips = [...film.matchAll(/<iframe id="(shot-\d+)"[^>]+src="([^#]+)#/g)];
    assert.equal(clips.length, 8);
    for (const [, id, src] of clips) {
      assert.equal(src, `${pages}/${id}.html`);
      const html = asset(base + src);
      const layers = inspectPageEditableLayers(html);
      assert.ok(html.includes(`vibe-page ${layout}`));
      assert.equal(layers.canvasCount, 0);
      assert.deepEqual(layers.duplicateElementIds, []);
      assert.ok(layers.elements.some(layer => layer.elementId === 'vibe-headline'));
      assert.ok(layers.elements.some(layer => layer.elementId === 'vibe-subtitle-2'));
      if (id === 'shot-07') assert.ok(layers.elements.some(layer => layer.elementId === 'vibe-item-3-detail'));
      else assert.ok(layers.elements.some(layer => layer.elementId === 'vibe-diagram'));
    }
  }
});

test('Vibe opener treats display text as data', () => {
  const html = renderVibeScene({ ...shot, copy: { lead1: '<img src=x>', slam: '</span><script>alert(1)</script>' } }, [1080, 1920]);
  assert.doesNotMatch(html, /<img src=x>|<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;img src=x&gt;/);
});
