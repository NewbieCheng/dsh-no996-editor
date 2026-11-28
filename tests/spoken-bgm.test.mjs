import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFilmFile } from 'openfilm/film-doc';
import { sha256Buffer } from '../src/audio/builtin-bgm.mjs';
import { prepareSpokenBgm } from '../src/audio/spoken-bgm.mjs';
import { extractMonoFloat32 } from '../src/audio/rhythm-analyzer.mjs';
import { buildSpokenBlueprint } from '../src/film/spoken-blueprint.mjs';
import { spokenProjectFiles } from '../src/film/spoken-project.mjs';

const plan = music => buildSpokenBlueprint({ music, copy: '现在开始。', transcript: [{ start: 0, end: 14 }],
  beats: [{ from: 0, to: 1, role: 'hook', headline: '开场', visual: 'Focus', motion: 'Reveal' }] });

function audioFixture() {
  const rate = 22050;
  const samples = new Float32Array(rate * 9);
  for (let i = 0; i < samples.length; i++) {
    const phase = i / rate % 0.5;
    if (phase < 0.057) samples[i] = Math.sin(i * 0.3) * Math.exp(-phase * 70) * 0.87;
  }
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) bytes.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2);
  return { bytes, samples, sampleRate: rate };
}

test('off mode never resolves audio and does not save a rhythm or a track', async () => {
  const bgm = await prepareSpokenBgm({ mode: 'none', resolveDefault: () => assert.fail('resolved default track') });
  assert.equal(bgm, null);
  const files = spokenProjectFiles(plan('none'), { bgm });
  assert.equal(files.has('.film/rhythm.json'), false);
  assert.equal(readFilmFile(files.get('film.html')).doc.tracks.length, 1);
  assert.deepEqual(JSON.parse(files.get('.film/spoken-blueprint.json')).accents, []);
});

test('default reuses rhythm only when the resolved bytes match the pinned fingerprint', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'no996-bgm-default-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'test.mp3');
  const bytes = Buffer.from('test-only audio fixture');
  const sha256 = sha256Buffer(bytes);
  await writeFile(file, bytes);
  const resolveDefault = async id => ({ file, spec: { id, sha256 } });
  const readDefaultRhythm = id => {
    assert.equal(id, 'vibe-we-never');
    return { durationSec: 20, beats: [440] };
  };
  const bgm = await prepareSpokenBgm({ mode: 'default', resolveDefault, readDefaultRhythm });
  const files = spokenProjectFiles(plan('default'), { bgm });
  assert.deepEqual(files.get(bgm.path), bytes);
  const { doc, problems } = readFilmFile(files.get('film.html'));
  assert.deepEqual(problems, []);
  assert.deepEqual(doc.tracks[1].clips[0].time, [0, 14]);
  assert.equal(doc.tracks[1].clips[0].volume, 0.16);
  assert.equal(JSON.parse(files.get('.film/spoken-blueprint.json')).accents[0].atMs, 440);
  await writeFile(file, 'changed');
  await assert.rejects(prepareSpokenBgm({ mode: 'default', resolveDefault, readDefaultRhythm }), { code: 'SPOKEN_BGM_UNAVAILABLE' });
});

test('upload measures the actual staged audio, keeps it project-local and does not loop short music', async () => {
  const { bytes, samples, sampleRate } = audioFixture();
  let path;
  const bgm = await prepareSpokenBgm({ mode: 'upload', upload: bytes, decode: async file => {
    path = file;
    assert.deepEqual(await readFile(file), bytes);
    return { samples, sampleRate };
  } });
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.ok(bgm.analysis.beats.length > 8);
  assert.equal(bgm.path, 'assets/audio/bgm/music.wav');
  const files = spokenProjectFiles(plan('upload'), { bgm });
  assert.equal(JSON.parse(files.get('.film/rhythm.json')).sha256, sha256Buffer(bytes));
  const { doc, problems } = readFilmFile(files.get('film.html'));
  assert.deepEqual(problems, []);
  assert.deepEqual(doc.tracks[1].clips[0].time, [0, 9]);
  await assert.rejects(prepareSpokenBgm({ mode: 'upload', upload: Buffer.from('#EXTM3U\nnot audio'), decode: () => assert.fail('not audio') }), { code: 'SPOKEN_BGM_INPUT' });
});

test('an installed FFmpeg decodes the generated WAV through the real pipeline', { skip: !process.env.NO996_TEST_FFMPEG }, async () => {
  const { bytes } = audioFixture();
  const bgm = await prepareSpokenBgm({ mode: 'upload', upload: bytes,
    decode: (path, options) => extractMonoFloat32(path, { ...options, resolve: () => process.env.NO996_TEST_FFMPEG }) });
  assert.equal(bgm.analysis.durationSec, 9);
  assert.ok(Math.abs(bgm.analysis.bpm - 120) < 3);
  assert.ok(bgm.analysis.beats.length > 8);
});
