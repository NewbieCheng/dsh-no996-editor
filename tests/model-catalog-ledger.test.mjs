import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelCatalogService } from '../src/host/model-catalog-service.mjs';
import { SENSE_VOICE, senseVoiceDir, senseVoiceReadyMark } from '../src/asr/asr-models.mjs';
import { createVisionPackManager, VISION_PACK_ID, VISION_WEIGHTS, visionPackDir, visionReadyMark } from '../src/vision/vision-pack.mjs';

test('model catalog ledger deduplicates hardlinks and reconciles Studio places.app without double counting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-'));
  const env = {
    DSH_HOME: join(root, '.dsh'),
    OPENFILM_HOME: join(root, '.openfilm'),
    XDG_CACHE_HOME: join(root, '.cache'),
  };
  try {
    // 1) Populate SenseVoice inside OPENFILM_HOME (`inHome`) with one hardlink duplicate
    const svDir = senseVoiceDir({ env, home: root });
    mkdirSync(svDir, { recursive: true });
    let svBytes = 0;
    for (const f of SENSE_VOICE.files) {
      const payload = Buffer.alloc(1024, 7);
      writeFileSync(join(svDir, f.name), payload);
      svBytes += payload.length;
    }
    writeFileSync(senseVoiceReadyMark({ env, home: root }), 'ok');
    const okBytes = Buffer.byteLength('ok');
    // Create hardlink inside same dir to verify inode deduplication
    linkSync(join(svDir, SENSE_VOICE.files[0].name), join(svDir, 'hardlink-dup.bin'));

    // 2) Populate Vision Pack inside DSH_HOME (`external` to OPENFILM_HOME)
    const vpDir = visionPackDir({ env, home: root });
    mkdirSync(vpDir, { recursive: true });
    const srcModels = join(process.cwd(), 'packages', 'no996-models-vision', 'models');
    let vpBytes = 0;
    for (const w of VISION_WEIGHTS) {
      const buf = readFileSync(join(srcModels, w.id));
      writeFileSync(join(vpDir, w.id), buf);
      vpBytes += buf.length;
    }
    writeFileSync(visionReadyMark({ env, home: root }), 'ok');

    const visionPack = createVisionPackManager({ env, home: root, openfilmPkgRoot: join(root, 'none') });
    const fakeTranscribe = {
      status: async () => ({ ready: true, engine: 'ready', installing: false, dir: svDir, bytesTotal: svBytes, bytesOnDisk: svBytes }),
      isBusy: () => false,
      resetRecognizer() {},
    };

    const catalog = createModelCatalogService({
      env,
      home: root,
      openfilmPkgRoot: join(root, 'none'),
      visionPack,
      transcribeService: fakeTranscribe,
    });

    const snap = await catalog.snapshot();
    // Hardlink was NOT double-counted! (`ok` marker inside svDir counts toward inHomeModelsBytes)
    assert.equal(snap.totals.inHomeModelsBytes, svBytes + okBytes);
    assert.equal(snap.totals.externalModelsBytes, vpBytes + okBytes);
    assert.equal(snap.totals.modelsBytes, svBytes + okBytes + vpBytes + okBytes);

    const runtimeItem = snap.items.find((it) => it.id === 'no996-vision-runtime');
    assert.ok(runtimeItem);
    assert.equal(runtimeItem.sourceKind, 'bundled');
    assert.equal(runtimeItem.canDelete, false);
    assert.equal(runtimeItem.enabledState, 'unavailable');

    const bundledCatalog = createModelCatalogService({
      env,
      home: root,
      visionPack: createVisionPackManager({ env, home: root }),
      transcribeService: fakeTranscribe,
    });
    const bundledRuntime = (await bundledCatalog.snapshot()).items.find((it) => it.id === 'no996-vision-runtime');
    assert.equal(bundledRuntime.enabledState, 'bundled');

    // Reconcile Studio places.app (`rawStudioApp` already includes inHomeModelsBytes + 2048 bytes of logs)
    const rawStudioApp = svBytes + okBytes + 2048;
    const reconciled = await catalog.reconcileStorage({
      places: { saved: 0, skills: 0, exports: 0, app: rawStudioApp },
      projects: [],
    });
    assert.equal(reconciled.no996Breakdown.otherAppBytes, 2048);
    assert.equal(reconciled.no996Breakdown.localModelsBytes, svBytes + okBytes + vpBytes + okBytes);
    assert.equal(reconciled.places.app, rawStudioApp + vpBytes + okBytes);

    // Deleting Vision Pack shrinks modelsBytes cleanly
    const removed = await catalog.removeModelById(VISION_PACK_ID);
    assert.equal(removed.ok, true);
    assert.equal(removed.catalog.totals.externalModelsBytes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removeModelById blocks deletion with MODEL_IN_USE when SenseVoice is busy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ledger-busy-'));
  const env = { DSH_HOME: join(root, '.dsh'), OPENFILM_HOME: join(root, '.openfilm') };
  try {
    const catalog = createModelCatalogService({
      env,
      home: root,
      visionPack: createVisionPackManager({ env, home: root, openfilmPkgRoot: join(root, 'none') }),
      transcribeService: {
        status: async () => ({ ready: true, installing: false, engine: 'ready' }),
        isBusy: () => true,
        resetRecognizer() {},
      },
    });
    await assert.rejects(
      () => catalog.removeModelById(SENSE_VOICE.id),
      (err) => err?.code === 'MODEL_IN_USE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
