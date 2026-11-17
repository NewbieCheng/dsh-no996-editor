import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relatedTests } from '../scripts/check-quick.mjs';

test('quick check selects changed tests and transitive static importers', () => {
  const root = mkdtempSync(join(tmpdir(), 'openfilm-quick-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'src', 'base.mjs'), 'export const a = 1;');
    writeFileSync(join(root, 'src', 'layer.mjs'), "export { a } from './base.mjs';");
    writeFileSync(join(root, 'tests', 'one.test.mjs'), "import { a } from '../src/layer.mjs';");
    writeFileSync(join(root, 'tests', 'two.test.mjs'), "import test from 'node:test';");
    assert.deepEqual(relatedTests(root, ['src/base.mjs']), ['tests/one.test.mjs']);
    rmSync(join(root, 'src', 'base.mjs'));
    assert.deepEqual(relatedTests(root, ['src/base.mjs']), ['tests/one.test.mjs']);
    assert.deepEqual(relatedTests(root, ['tests/two.test.mjs']), ['tests/two.test.mjs']);
    assert.deepEqual(relatedTests(root, ['README.md']), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
