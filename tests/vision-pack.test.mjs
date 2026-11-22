import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  createVisionPackManager,
  extractTarEntries,
  legacyUserVisionDir,
  probeLegacyVisionWeights,
  resolveVisionAsset,
  VISION_WEIGHTS,
  visionSources,
} from '../src/vision/vision-pack.mjs';

function makeTar(entries) {
  const chunks = [];
  for (const { name, data, typeFlag = '0' } of entries) {
    const hdr = Buffer.alloc(512, 0);
    hdr.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
    hdr.write('0000644\0', 100, 8, 'ascii');
    hdr.write('0000000\0', 108, 8, 'ascii');
    hdr.write('0000000\0', 116, 8, 'ascii');
    const size = data ? data.length : 0;
    hdr.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    hdr.write('00000000000\0', 136, 12, 'ascii');
    hdr.fill(' ', 148, 156);
    hdr.write(typeFlag, 156, 1, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += hdr[i];
    hdr.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(hdr);
    if (size > 0) {
      const pad = Math.ceil(size / 512) * 512;
      const body = Buffer.alloc(pad, 0);
      data.copy(body);
      chunks.push(body);
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

test('visionSources prioritizes mirror before official npmjs and honors override', () => {
  const defaults = visionSources({});
  assert.equal(defaults[0].id, 'npmmirror');
  assert.equal(defaults[1].id, 'npmjs');

  const custom = visionSources({ NO996_VISION_PACK_URL: 'https://intranet.local/vision.tgz' });
  assert.equal(custom.length, 1);
  assert.equal(custom[0].url, 'https://intranet.local/vision.tgz');
});

test('extractTarEntries rejects path traversal, symlinks, and backslashes', () => {
  assert.throws(
    () => extractTarEntries(makeTar([{ name: 'package/../evil.txt', data: Buffer.from('x') }])),
    (err) => err?.code === 'UNSAFE_ARCHIVE_PATH',
  );
  assert.throws(
    () => extractTarEntries(makeTar([{ name: '/etc/passwd', data: Buffer.from('x') }])),
    (err) => err?.code === 'UNSAFE_ARCHIVE_PATH',
  );
  assert.throws(
    () => extractTarEntries(makeTar([{ name: 'package\\models\\portrait.onnx', data: Buffer.from('x') }])),
    (err) => err?.code === 'UNSAFE_ARCHIVE_PATH',
  );
  assert.throws(
    () => extractTarEntries(makeTar([{ name: 'package/models/portrait.onnx', data: Buffer.alloc(0), typeFlag: '2' }])),
    (err) => err?.code === 'UNSAFE_ARCHIVE_LINK',
  );
});

test('resolveVisionAsset throws VISION_MODEL_NOT_INSTALLED on clean machine without hitting network', async () => {
  const home = mkdtempSync(join(tmpdir(), 'vp-empty-'));
  try {
    await assert.rejects(
      () => resolveVisionAsset('portrait.onnx', {
        env: { DSH_HOME: join(home, '.dsh'), OPENFILM_HOME: join(home, '.openfilm') },
        home,
        openfilmPkgRoot: join(home, 'no-bundled'),
      }),
      (err) => err?.code === 'VISION_MODEL_NOT_INSTALLED',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('legacy weights resolve read-only, pre-migrate into managed store, and obey active lease MODEL_IN_USE guard', async () => {
  const realWeightDir = join(process.cwd(), 'packages', 'no996-models-vision', 'models');
  const root = mkdtempSync(join(tmpdir(), 'vp-mig-'));
  const env = { DSH_HOME: join(root, '.dsh'), OPENFILM_HOME: join(root, '.openfilm') };
  try {
    const legacyDir = legacyUserVisionDir({ env, home: root });
    mkdirSync(legacyDir, { recursive: true });
    for (const spec of VISION_WEIGHTS) {
      const buf = readFileSync(join(realWeightDir, spec.id));
      assert.equal(createHash('sha256').update(buf).digest('hex'), spec.sha256);
      writeFileSync(join(legacyDir, spec.id), buf);
    }

    const legacyProbe = await probeLegacyVisionWeights({ env, home: root, openfilmPkgRoot: join(root, 'none') });
    assert.equal(legacyProbe.available, true);
    assert.equal(legacyProbe.sourceKind, 'legacy_cache');

    const mgr = createVisionPackManager({ env, home: root, openfilmPkgRoot: join(root, 'none') });
    const before = await mgr.status();
    assert.equal(before.managed, false);
    assert.equal(before.reusableLocal, true);

    const mig = await mgr.preMigrateLegacy();
    assert.equal(mig.migrated, true);
    assert.equal(mig.status.managed, true);

    const resolved = await mgr.resolveAsset('portrait.onnx');
    assert.equal(resolved.sourceKind, 'managed');

    const releaseLease = mgr.acquireLease('portrait.onnx');
    await assert.rejects(() => mgr.remove(), (err) => err?.code === 'MODEL_IN_USE');
    releaseLease();

    const afterRemove = await mgr.remove();
    assert.equal(afterRemove.managed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('importFromLocalTarball validates SHA-256 and cancelInstall aborts + cleans tmp', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vp-imp-'));
  const env = { DSH_HOME: join(root, '.dsh'), OPENFILM_HOME: join(root, '.openfilm') };
  try {
    const realWeightDir = join(process.cwd(), 'packages', 'no996-models-vision', 'models');
    const tar = makeTar(VISION_WEIGHTS.map((w) => ({
      name: w.archivePath,
      data: readFileSync(join(realWeightDir, w.id)),
    })));
    const tgzPath = join(root, 'vision-test.tgz');
    writeFileSync(tgzPath, gzipSync(tar));

    const mgr = createVisionPackManager({ env, home: root, openfilmPkgRoot: join(root, 'none') });
    const st = await mgr.importFromLocalTarball(tgzPath);
    assert.equal(st.managed, true);
    assert.equal(st.capabilities.every((w) => w.weightsPresent), true);

    // Corrupt tar weight check
    const badTar = makeTar(VISION_WEIGHTS.map((w, idx) => ({
      name: w.archivePath,
      data: idx === 0 ? Buffer.from('corrupt-bytes') : readFileSync(join(realWeightDir, w.id)),
    })));
    const badPath = join(root, 'bad.tgz');
    writeFileSync(badPath, gzipSync(badTar));
    await assert.rejects(() => mgr.importFromLocalTarball(badPath), (err) => err?.code === 'VISION_CHECKSUM_FAILED');

    const cancelled = await mgr.cancelInstall();
    assert.equal(cancelled.installing, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
