import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectPageEditableLayers } from '../src/film/editable-check.mjs';

for (const [orientation, pages, width, height] of [['portrait', 'pages', 1080, 1920], ['landscape', 'pages-landscape', 1920, 1080]]) {
  test(`motion studies ${orientation} keep text and geometry editable`, () => {
    for (const [id, prefix] of [['shot-01', 'motion-flat'], ['shot-02', 'motion-bauhaus']]) {
      const html = readFileSync(new URL(`../vendor/templates/motion-styles/${pages}/${id}.html`, import.meta.url), 'utf8');
      const layers = inspectPageEditableLayers(html);
      assert.ok(html.includes(`width: ${width}, height: ${height}`));
      assert.ok(html.includes(`class="motion-study ${id === 'shot-01' ? 'flat' : 'bauhaus'} ${orientation}"`));
      assert.equal(layers.canvasCount, 0);
      assert.deepEqual(layers.duplicateElementIds, []);
      assert.ok(layers.elements.some(layer => layer.elementId === `${prefix}-headline`));
      assert.ok(layers.elements.some(layer => layer.elementId === `${prefix}-deck`));
      const geometry = id === 'shot-01' ? 'motion-flat-city' : 'motion-bauhaus-shapes';
      assert.ok(layers.elements.some(layer => layer.elementId === geometry));
      assert.doesNotMatch(html, /fillText|createElement\(['"]canvas['"]\)|window\.fetch =/);
      if (id === 'shot-02') assert.match(html, /class="bauhaus-red" data-bauhaus-red/);
    }
  });
}
