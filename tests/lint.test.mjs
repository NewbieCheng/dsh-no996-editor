import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lintSource = fileURLToPath(new URL('../scripts/lint.mjs', import.meta.url));

test('full lint checks syntax and fails on invalid source', () => {
  const root = mkdtempSync(join(tmpdir(), 'openfilm-lint-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src'));
    copyFileSync(lintSource, join(root, 'scripts', 'lint.mjs'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.0.0', engines: { node: '>=22' }, dsh: { bundle: { patch: 'cordis.patch.yml' }, client: { platform: 'web' } }, files: ['index.js', 'client.js', 'cordis.patch.yml'] }));
    writeFileSync(join(root, 'cordis.patch.yml'), '[]\n');
    writeFileSync(join(root, 'src', 'broken.mjs'), 'export const value = ;\n');
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'lint.mjs'), '--strict'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /src\/broken\.mjs: syntax check failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
