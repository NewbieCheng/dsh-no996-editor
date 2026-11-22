import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { VISION_WEIGHTS } from '../src/vision/vision-pack.mjs';

test('split vision package holds exact 3 weights with valid manifest and zero deps', () => {
  const dir = join(process.cwd(), 'packages', 'no996-models-vision');
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

  assert.equal(pkg.name, '@newbiecheng/no996-models-vision');
  assert.equal(pkg.version, '0.2.0');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts, undefined);
  assert.equal(manifest.models.length, 3);

  for (const spec of VISION_WEIGHTS) {
    const file = join(dir, 'models', spec.id);
    assert.equal(existsSync(file), true, `missing ${spec.id}`);
    assert.equal(readFileSync(file).byteLength, spec.bytes);
  }
});

test('main package declares openfilm runtime deps and pack-tgz strips split vision weights & disables auto-download', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['onnxruntime-web']);
  assert.ok(pkg.dependencies['@mediapipe/tasks-vision']);
  assert.equal(pkg.files.includes('packages/**'), false);

  const out = mkdtempSync(join(tmpdir(), 'pack-split-'));
  try {
    execFileSync(process.execPath, ['scripts/pack-tgz.mjs', '--out-dir', out], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    const archive = join(out, `newbiecheng-dsh-no996-editor-${pkg.version}.tgz`);
    assert.equal(existsSync(archive), true);

    const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
    const list = execFileSync(tar, ['-tzf', archive], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const entries = new Set(list.split(/\r?\n/).filter(Boolean).map((n) => n.replace(/^\.\//, '')));

    for (const w of VISION_WEIGHTS) {
      assert.equal(entries.has(`package/node_modules/openfilm/models/vision/${w.id}`), false, `split weight ${w.id} leaked into main tarball`);
    }
    assert.equal(entries.has('package/node_modules/openfilm/node_modules/onnxruntime-web/package.json'), true);

    const patchedVisionAssets = execFileSync(
      tar,
      ['-xOzf', archive, 'package/node_modules/openfilm/src/vision-assets.mjs'],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.ok(patchedVisionAssets.includes('NO996_VISION_MODELS_DIR'));
    assert.ok(patchedVisionAssets.includes('NO996_NO_AUTO_VISION_DOWNLOAD'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
