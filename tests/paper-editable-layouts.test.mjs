import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectPageEditableLayers } from '../src/film/editable-check.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

for (const [orientation, pages, width, height] of [['portrait', 'pages', 1080, 1920], ['landscape', 'pages-landscape', 1920, 1080]]) {
  test(`paper ${orientation} keeps lecture text and placeholders independently editable`, () => {
    for (const id of ['shot-01', 'shot-02']) {
      const html = read(`../vendor/templates/paper-texture/${pages}/${id}.html`);
      assert.match(html, new RegExp(`window\\.film = \\{ width: ${width}, height: ${height}`));
      const layers = inspectPageEditableLayers(html);
      assert.equal(layers.canvasCount, 0);
      assert.deepEqual(layers.duplicateElementIds, []);
      for (const layer of ['paper-headline', 'paper-subtitle']) assert.ok(layers.elements.some(item => item.elementId === layer), layer);
      if (id === 'shot-01') {
        for (const layer of ['paper-courseware', 'paper-presenter', 'paper-nameplate']) assert.ok(layers.elements.some(item => item.elementId === layer), layer);
      } else {
        for (const layer of ['paper-steps', 'paper-step-1-title', 'paper-step-3-body']) assert.ok(layers.elements.some(item => item.elementId === layer), layer);
      }
      if (orientation === 'landscape') {
        assert.match(html, /class="paper-page landscape"/);
        assert.match(html, /grid-template-columns: repeat\(3/);
      } else assert.doesNotMatch(html, /paper-page landscape/);
    }
  });
}
