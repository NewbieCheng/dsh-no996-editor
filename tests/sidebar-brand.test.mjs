import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { brandSvgMarkup, installSidebarBrand } from '../src/ui/sidebar-brand.mjs';

test('brandSvgMarkup renders light and dark No996 marks', () => {
  const dark = brandSvgMarkup({ dark: true, size: 22 });
  const light = brandSvgMarkup({ dark: false, size: 22 });
  assert.ok(dark.includes('#FFFFFF') && dark.includes('#FF7200'));
  assert.ok(light.includes('#051D43') && light.includes('#FF6400'));
});

test('installSidebarBrand is safe and returns a cleanup function on minimal documents', () => {
  const dispose = installSidebarBrand({ document: null });
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('theme tokens no longer carry workbench palette presets', () => {
  const tokens = readFileSync(new URL('../assets/theme/tokens.css', import.meta.url), 'utf8');
  assert.ok(tokens.includes('--n996-accent-ink'));
  assert.equal(tokens.includes('data-n996-theme'), false);
  assert.equal(tokens.includes('data-n996-accent'), false);
});
