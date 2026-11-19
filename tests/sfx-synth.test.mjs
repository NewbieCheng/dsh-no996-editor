import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  packCuesToLanes,
  renderSfxStem,
  SFX_CATALOG,
  SFX_KINDS,
  SFX_SAMPLE_RATE,
  synthesizeSfxWav,
} from '../src/audio/sfx-synth.mjs';
import { createSfxTool } from '../src/tools/sfx-tool.mjs';

test('all 12 SFX kinds synthesize valid deterministic 48kHz stereo WAV buffers', () => {
  assert.equal(SFX_KINDS.length, 12);
  for (const kind of SFX_KINDS) {
    const a = synthesizeSfxWav(kind);
    const b = synthesizeSfxWav(kind);
    assert.equal(Buffer.compare(a.wav, b.wav), 0, `${kind} must be deterministic`);
    assert.equal(a.wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(a.wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(a.wav.readUInt16LE(22), 2, `${kind} stereo`);
    assert.equal(a.wav.readUInt32LE(24), SFX_SAMPLE_RATE, `${kind} 48kHz`);
    assert.equal(a.wav.readUInt16LE(34), 16, `${kind} 16-bit`);
    assert.ok(a.duration >= SFX_CATALOG[kind].duration - 0.05);
  }
});

test('packCuesToLanes splits overlapping cues so same-lane clips never overlap', () => {
  const lanes = packCuesToLanes([
    { at: 0.0, kind: 'hit' },     // ends ~0.70s
    { at: 0.2, kind: 'whoosh' },  // overlaps lane 0 -> goes to lane 1
    { at: 0.8, kind: 'pop' },     // fits after 0.70s + gap -> lane 0
    { at: 0.85, kind: 'bell' },   // overlaps pop -> goes to lane 1 (whoosh ends 0.75s)
  ], 0.02);
  assert.ok(lanes.length >= 2);
  for (const lane of lanes) {
    let cursor = -1;
    for (const item of lane.items) {
      assert.ok(item.at >= cursor, `lane ${lane.lane} overlap at ${item.at} < ${cursor}`);
      cursor = item.at + item.duration;
    }
  }
});

test('renderSfxStem enforces -1.2 dBFS peak ceiling even with stacked gain', () => {
  const cues = Array.from({ length: 16 }, (_, i) => ({ at: i * 0.05, kind: i % 4 === 0 ? 'hit' : 'click', gain: 1.8 }));
  const stem = renderSfxStem(cues, 3.0);
  assert.equal(stem.wav.toString('ascii', 0, 4), 'RIFF');
  assert.ok(stem.peakDb <= -1.15, `peakDb should stay <= -1.15 dBFS, got ${stem.peakDb}`);
  assert.ok(stem.duckPoints.includes(0));
});

test('openfilm_sfx supports list, clips, stem, and blocks unsafe output paths', async t => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'openfilm-sfx-tool-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const tool = createSfxTool({
    isProjectAgent: () => true,
    projectOf: () => ({ projectId: 'p1', path: projectRoot }),
  });

  const listed = await tool.execute({ mode: 'list' }, { agent: { session: { id: 's1' } } });
  assert.ok(listed.text.includes('whoosh') && listed.text.includes('hit'));

  const clipsRes = await tool.execute({
    mode: 'clips',
    cues: [
      { at: 0.5, kind: 'hit' },
      { at: 0.65, kind: 'pop' },
    ],
  }, { agent: { session: { id: 's1' } } });
  assert.ok(clipsRes.text.includes('<section id="sfx-'));
  assert.ok(existsSync(join(projectRoot, '.film', 'sfx-cues.json')));
  assert.ok(existsSync(join(projectRoot, 'assets', 'audio', 'sfx', 'hit.wav')));

  const stemRes = await tool.execute({
    mode: 'stem',
    duration: 4,
    out: 'assets/audio/custom-stem.wav',
    cues: [{ at: 0.4, kind: 'bell', pitch: 784 }],
  }, { agent: { session: { id: 's1' } } });
  assert.ok(stemRes.text.includes('assets/audio/custom-stem.wav'));
  const wav = readFileSync(join(projectRoot, 'assets', 'audio', 'custom-stem.wav'));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');

  await assert.rejects(
    () => tool.execute({ mode: 'stem', out: '../bad.wav', cues: [{ at: 0, kind: 'hit' }] }, { agent: { session: { id: 's1' } } }),
    /assets\/audio\//,
  );
});
