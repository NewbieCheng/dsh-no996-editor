import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { createVoiceBridge, installVoiceBridgeGlobal, VOICE_BRIDGE } from '../src/voice/voice-bridge.mjs';
import { installNo996Provider, preferNo996ForTts } from '../src/voice/install-no996-provider.mjs';

describe('no996 voice bridge', () => {
  const temps = [];
  after(async () => {
    for (const dir of temps) await rm(dir, { recursive: true, force: true });
  });

  it('maps workbench clones + platform voices into openfilm get voice receipt', async () => {
    const bridge = createVoiceBridge({
      auth: {
        baseUrl: 'https://worker.example.test',
        dev: false,
        async status() { return { loggedIn: true }; },
        async accessToken() { return 'tok'; },
      },
      fetchImpl: async (url) => {
        if (String(url).endsWith('/v1/audio/voices')) {
          return {
            ok: true,
            async text() {
              return JSON.stringify({
                data: [
                  { voice_id: 'clone-1', display_name: '阿珍', ready_for_synthesis: true, language_hint: 'zh' },
                  { voice_id: 'pending', display_name: '审核中', ready_for_synthesis: false },
                ],
              });
            },
          };
        }
        if (String(url).includes('/api/v1/models/default-tts')) {
          return {
            ok: true,
            async text() {
              return JSON.stringify({
                data: {
                  model_code: 'qwen-tts',
                  default_voice: 'longanlingxin',
                  platform_voices: [{ id: 'longanlingxin', label: '龙安灵心' }],
                },
              });
            },
          };
        }
        throw new Error(`unexpected ${url}`);
      },
    });

    await bridge.refreshReady();
    assert.equal(bridge.ready(), true);

    const result = await bridge.run('voice', { limit: 10 }, { signal: AbortSignal.timeout(5_000), say() {} });
    assert.equal(result.receipt.provider, 'no996');
    assert.deepEqual(
      result.receipt.voices.map((v) => v.voiceId),
      ['clone-1', 'longanlingxin'],
    );

    const library = await bridge.libraryVoicesPayload();
    assert.equal(library.providers[0].id, 'no996');
    assert.equal(library.voices.length, 2);
    assert.ok(library.voices.every((v) => v.provider === 'no996' && v.featured === true));
  });

  it('synthesizes tts into assets/audio/vo wav bytes', async () => {
    // Minimal WAV header + 1000 silent PCM samples.
    const samples = 1000;
    const dataSize = samples * 2;
    const wav = Buffer.alloc(44 + dataSize);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(36 + dataSize, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(dataSize, 40);

    const bridge = createVoiceBridge({
      auth: {
        baseUrl: 'https://worker.example.test',
        async status() { return { loggedIn: true }; },
        async accessToken() { return 'tok'; },
      },
      fetchImpl: async (url, init) => {
        if (String(url).endsWith('/api/v1/ai/audio/speech') && init?.method === 'POST') {
          return {
            ok: true,
            async text() {
              return JSON.stringify({ url: '/media/audio/demo.wav' });
            },
          };
        }
        if (String(url).endsWith('/media/audio/demo.wav')) {
          return {
            ok: true,
            async arrayBuffer() { return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength); },
          };
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    await bridge.refreshReady();
    const result = await bridge.run('tts', { out: 'line-1', text: '你好', voice: 'clone-1' }, { say() {} });
    assert.equal(result.files[0].path, 'assets/audio/vo/line-1.wav');
    assert.ok(result.files[0].bytes.byteLength > 44);
    assert.equal(result.receipt.provider, 'no996');
    assert.equal(result.index[0].voice, 'clone-1');
  });

  it('installs added-provider stub and prefers tts=no996', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nof-voice-'));
    temps.push(home);
    const env = { OPENFILM_SHARED_HOME: home, OPENFILM_HOME: home };
    const installed = await installNo996Provider({ env });
    assert.equal(installed.written, true);
    const body = await readFile(installed.providerFile, 'utf8');
    assert.match(body, /id: 'no996'/);
    assert.match(body, /Symbol\.for\('no996\.openfilm\.voice'\)/);
    // Mirrors openfilm studio/server/providers/added.mjs `checked()`: empty env
    // is rejected and the whole provider is silently dropped from get list.
    assert.match(body, /env:\s*'NO996_WORKBENCH'/);

    const pref = await preferNo996ForTts({ env, force: true });
    assert.equal(pref.changed, true);
    assert.equal(pref.use, 'no996');
    const settings = JSON.parse(await readFile(join(home, 'providers.json'), 'utf8'));
    assert.equal(settings.use.tts, 'no996');
  });

  it('stub passes OpenFilm added-provider field checks (non-empty env)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nof-voice-'));
    temps.push(home);
    const installed = await installNo996Provider({ env: { OPENFILM_SHARED_HOME: home, OPENFILM_HOME: home } });
    const mod = await import(`${pathToFileURL(installed.providerFile).href}?t=${Date.now()}`);
    const p = mod.default;
    for (const field of ['id', 'name', 'env']) {
      assert.equal(typeof p[field], 'string');
      assert.ok(p[field], `added.mjs rejects empty ${field}`);
    }
    assert.ok(Array.isArray(p.verbs) && p.verbs.length);
    assert.equal(typeof p.run, 'function');
    assert.equal(typeof p.ready, 'function');
  });

  it('registers the process-wide bridge for the stub provider', async () => {
    const bridge = createVoiceBridge({
      auth: {
        baseUrl: 'https://worker.example.test',
        async status() { return { loggedIn: false }; },
        async accessToken() { return null; },
      },
    });
    const dispose = installVoiceBridgeGlobal(bridge);
    assert.equal(globalThis[VOICE_BRIDGE], bridge);
    dispose();
    assert.equal(globalThis[VOICE_BRIDGE], undefined);
  });
});
