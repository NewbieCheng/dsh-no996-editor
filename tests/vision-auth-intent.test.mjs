import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeSourceRevision, createVisionAuthStore } from '../src/host/vision-auth-store.mjs';
import { createVisionTools } from '../src/tools/vision-tool.mjs';

test('VisionAuthStore & no996_cutout block forged confirmation, stale revision, cross-asset/conversation leakage, and whole_clip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vauth-'));
  try {
    writeFileSync(join(dir, 'clip-a.mp4'), 'video-a-v1');
    writeFileSync(join(dir, 'clip-b.mp4'), 'video-b-v1');

    const authStore = createVisionAuthStore();
    let analyzeCalls = 0;
    const tools = createVisionTools({
      isProjectAgent: () => true,
      projectOf: () => ({ projectId: 'proj1234', path: dir, conversation: 'conv-1', available: true }),
      attachments: () => null,
      authStore,
      requireConfirmation: true,
      extract: async () => Buffer.from('frame'),
      browser: async (_mode, fn) => {
        analyzeCalls += 1;
        // Minimal valid 1x1 RGBA PNG header (IHDR colorType = 6) + length >= 26 bytes
        const rgbaPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex').toString('base64');
        return fn(async () => ({ png: rgbaPng, foregroundFraction: 0.42, width: 100, height: 100 }));
      },
    });
    const cutoutTool = tools.find((t) => t.name === 'no996_cutout');
    assert.ok(cutoutTool);

    // 1) Forged confirmed=true without Host authorization fails
    await assert.rejects(
      () => cutoutTool.execute({ source: 'clip-a.mp4', confirmed: true }, { agent: {} }),
      (err) => err?.code === 'CUTOUT_CONFIRMATION_REQUIRED',
    );
    assert.equal(analyzeCalls, 0);

    // 2) Host authorizes single_frame on clip-a.mp4 (v1)
    const rev1 = await computeSourceRevision(dir, 'clip-a.mp4');
    authStore.authorize({
      projectId: 'proj1234',
      conversation: 'conv-1',
      assetId: 'clip-a.mp4',
      operation: 'cutout_preview',
      scope: 'single_frame',
      sourceRevision: rev1,
      grantedBy: 'user_action',
    });

    // 3) Switching to clip-b.mp4 does NOT inherit clip-a authorization
    await assert.rejects(
      () => cutoutTool.execute({ source: 'clip-b.mp4' }, { agent: {} }),
      (err) => err?.code === 'CUTOUT_CONFIRMATION_REQUIRED',
    );

    // 4) Requesting scope=whole_clip rejects cleanly
    await assert.rejects(
      () => cutoutTool.execute({ source: 'clip-a.mp4', scope: 'whole_clip' }, { agent: {} }),
      (err) => err?.code === 'WHOLE_CLIP_UNSUPPORTED',
    );

    // 5) Mutating clip-a.mp4 invalidates sourceRevision -> CUTOUT_CONFIRMATION_REQUIRED
    writeFileSync(join(dir, 'clip-a.mp4'), 'video-a-v2-modified-bytes');
    await assert.rejects(
      () => cutoutTool.execute({ source: 'clip-a.mp4' }, { agent: {} }),
      (err) => err?.code === 'CUTOUT_CONFIRMATION_REQUIRED' && err.message.includes('已更新'),
    );

    // 6) Re-authorize with new revision -> succeeds
    const rev2 = await computeSourceRevision(dir, 'clip-a.mp4');
    authStore.authorize({
      projectId: 'proj1234',
      conversation: 'conv-1',
      assetId: 'clip-a.mp4',
      operation: 'cutout_preview',
      scope: 'single_frame',
      sourceRevision: rev2,
      grantedBy: 'user_action',
    });
    const ok = await cutoutTool.execute({ source: 'clip-a.mp4' }, { agent: {} });
    assert.ok(ok.text.includes('assets/vision'));
    assert.equal(analyzeCalls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
