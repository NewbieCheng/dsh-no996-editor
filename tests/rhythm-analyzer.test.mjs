import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  analyzeAudioSamples,
  DEFAULT_SAMPLE_RATE,
  fftRadix2,
  planRhythmEvents,
} from '../src/audio/rhythm-analyzer.mjs';
import { createRhythmTool } from '../src/tools/rhythm-tool.mjs';

function makeSyntheticTrack({ durationSec = 10, bpm = 120, sr = DEFAULT_SAMPLE_RATE } = {}) {
  const n = Math.floor(durationSec * sr);
  const samples = new Float32Array(n);
  const step = 60 / bpm;
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const mod = (t % step);
    // Climax window between 4s and 7.5s gets 2.5x kick amplitude + warm chord
    const boost = t >= 4 && t <= 7.5 ? 2.4 : 0.7;
    const kick = mod < 0.09 ? Math.sin(2 * Math.PI * (55 + 110 * Math.exp(-mod * 45)) * mod) * Math.exp(-mod * 28) * 0.45 * boost : 0;
    const hat = Math.abs(mod - step / 2) < 0.03 ? Math.sin(2 * Math.PI * 3400 * t) * Math.exp(-Math.abs(mod - step / 2) * 80) * 0.12 : 0;
    samples[i] = Math.max(-0.98, Math.min(0.98, kick + hat));
  }
  return samples;
}

test('fftRadix2 isolates pure cosine frequency bin', () => {
  const N = 1024;
  const bin = 16;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < N; i += 1) re[i] = Math.cos((2 * Math.PI * bin * i) / N);
  fftRadix2(re, im);
  let maxBin = 0;
  let maxMag = 0;
  for (let i = 0; i < N / 2; i += 1) {
    const mag = Math.hypot(re[i], im[i]);
    if (mag > maxMag) { maxMag = mag; maxBin = i; }
  }
  assert.equal(maxBin, bin);
  assert.ok(maxMag > 400);
});

test('analyzeAudioSamples detects 120 BPM beats, climaxes, and beat-aligned plan', () => {
  const samples = makeSyntheticTrack({ durationSec: 12, bpm: 120 });
  const analysis = analyzeAudioSamples(samples, DEFAULT_SAMPLE_RATE);
  assert.equal(analysis.version, 1);
  assert.ok(Math.abs(analysis.durationSec - 12) < 0.05);
  assert.ok(analysis.bpm >= 110 && analysis.bpm <= 130 || analysis.bpm >= 55 && analysis.bpm <= 65, `unexpected BPM ${analysis.bpm}`);
  assert.ok(analysis.beats.length >= 8, `expected >= 8 beats, got ${analysis.beats.length}`);
  assert.ok(analysis.onsets.length >= 6);
  assert.ok(analysis.energyCurve.length > 10);
  assert.ok(analysis.climaxes.some(c => c.peakAt >= 3.5 && c.peakAt <= 8.2), 'should detect louder 4..7.5s climax band');

  const plan = planRhythmEvents(analysis, { maxScenes: 8 });
  assert.ok(plan.sceneEvents.length >= 2);
});

test('openfilm_rhythm caches .film/rhythm.json, writes assets/rhythm-data.js, and rejects escapes', async t => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'openfilm-rhythm-tool-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  writeFileSync(join(projectRoot, 'bgm.mp3'), 'stub-mp3-bytes');
  const samples = makeSyntheticTrack({ durationSec: 8, bpm: 120 });
  let extractCalls = 0;

  const tool = createRhythmTool({
    isProjectAgent: () => true,
    projectOf: () => ({ projectId: 'p1', path: projectRoot }),
    extract: async () => {
      extractCalls += 1;
      return { samples, sampleRate: DEFAULT_SAMPLE_RATE };
    },
  });

  const first = await tool.execute({ source: 'bgm.mp3', writeDataJs: true }, { agent: { session: { id: 's1' } } });
  assert.equal(extractCalls, 1);
  assert.ok(first.text.includes('音乐/音频实测节奏分析'));
  assert.ok(existsSync(join(projectRoot, '.film', 'rhythm.json')));
  const jsBody = readFileSync(join(projectRoot, 'assets', 'rhythm-data.js'), 'utf8');
  assert.ok(jsBody.includes('window.RHYTHM = '));

  const second = await tool.execute({ source: 'bgm.mp3', writeDataJs: false }, { agent: { session: { id: 's1' } } });
  assert.equal(extractCalls, 1, 'second identical hash call should hit .film/rhythm.json cache');
  assert.ok(second.text.includes('命中缓存'));

  await assert.rejects(() => tool.execute({ source: '../outside.mp3' }, { agent: { session: { id: 's1' } } }), /相对路径|不能包含/);
});
