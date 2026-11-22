import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreferencesStore } from '../src/host/preferences.mjs';
import { createAsrChoiceResolver } from '../src/native/asr-choice.mjs';
import { createTranscribeService } from '../src/asr/transcribe-service.mjs';

function silenceWav(seconds = 1, rate = 16000) {
  const samples = Math.floor(seconds * rate);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes, 0);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

test('AsrChoiceResolver never auto-downloads, honors off/remote, and never falls back silently from local missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asr-choice-'));
  try {
    const preferences = createPreferencesStore({ home: dir });
    let svReady = false;
    const fakeTranscribe = {
      status: async () => ({
        ready: svReady,
        engine: 'ready',
        installing: false,
        bytesTotal: 228 * 1024 * 1024,
        bytesOnDisk: svReady ? 228 * 1024 * 1024 : 0,
        progress: svReady ? 1 : 0,
      }),
    };
    const resolver = createAsrChoiceResolver({ preferences, transcribeService: fakeTranscribe });

    // Clean machine: unset stays unset and unavailable without auto-download
    const r0 = await resolver.resolve({ purpose: 'media' });
    assert.equal(r0.configured, 'unset');
    assert.equal(r0.available, false);
    assert.equal((await preferences.get()).asrChoice, 'unset');

    // Explicit `off` stays `off` even after SenseVoice becomes ready & install finishes
    await resolver.setChoice('off');
    svReady = true;
    await resolver.enableLocalAfterInstall();
    const rOff = await resolver.resolve({ purpose: 'media' });
    assert.equal(rOff.configured, 'off');
    assert.equal(rOff.available, false);

    // Explicit `remote:*` blocks dictation upload!
    await resolver.setChoice('remote:whisper-cloud');
    const rMediaRemote = await resolver.resolve({ purpose: 'media' });
    assert.equal(rMediaRemote.available, true);
    const rDictationRemote = await resolver.resolve({ purpose: 'dictation' });
    assert.equal(rDictationRemote.available, false);
    assert.equal(rDictationRemote.reason, 'DICTATION_LOCAL_REQUIRED');

    // `local:sensevoice-small` with missing weights stays local & unavailable (no cloud fallback)
    await resolver.setChoice('local:sensevoice-small');
    svReady = false;
    const rLocalMissing = await resolver.resolve({ purpose: 'media' });
    assert.equal(rLocalMissing.effective, 'local:sensevoice-small');
    assert.equal(rLocalMissing.available, false);
    assert.equal(rLocalMissing.reason, 'MODEL_MISSING');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('transcribeAudioBuffer never triggers auto-download when SenseVoice is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asr-buf-'));
  const origDsh = process.env.DSH_HOME;
  const origOf = process.env.OPENFILM_HOME;
  process.env.DSH_HOME = join(dir, '.dsh');
  process.env.OPENFILM_HOME = join(dir, '.openfilm');
  let fetchCalled = false;
  try {
    const svc = createTranscribeService({
      fetchImpl: async () => { fetchCalled = true; throw new Error('network forbidden'); },
    });
    await assert.rejects(
      () => svc.transcribeAudioBuffer({ wavBuffer: silenceWav(), lang: 'auto' }),
      (err) => err?.code === 'MODEL_NOT_READY',
    );
    assert.equal(fetchCalled, false);
  } finally {
    if (origDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = origDsh;
    if (origOf === undefined) delete process.env.OPENFILM_HOME; else process.env.OPENFILM_HOME = origOf;
    rmSync(dir, { recursive: true, force: true });
  }
});
