import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNo996VoiceSettings } from '../src/voice/no996-voice-settings.mjs';

function memorySettings(initial = {}) {
  let s = {
    use: { ...(initial.use ?? {}) },
    model: { ...(initial.model ?? {}) },
    off: [...(initial.off ?? [])],
  };
  return {
    async readSettings() {
      return { keys: {}, use: { ...s.use }, model: { ...s.model }, off: [...s.off], custom: [], accounts: {}, libraryOff: false };
    },
    async changeSettings(edit) {
      const next = { keys: {}, use: { ...s.use }, model: { ...s.model }, off: [...s.off], custom: [], accounts: {}, libraryOff: false };
      edit(next);
      s = { use: { ...next.use }, model: { ...next.model }, off: [...next.off] };
      return { keys: {}, use: { ...s.use }, model: { ...s.model }, off: [...s.off], custom: [], accounts: {}, libraryOff: false };
    },
    snapshot: () => s,
  };
}

const readyBridge = (voices = [{ id: 'v1' }]) => ({
  async refreshReady() { return true; },
  async listCatalog() { return { clones: voices, platform: [] }; },
});

const signedOutAuth = () => ({ async status() { return { loggedIn: false }; } });
const loggedInAuth = () => ({ async status() { return { loggedIn: true }; } });

test('auto-selects no996 tts only when ready and nothing chosen', async () => {
  const keys = memorySettings();
  const vs = createNo996VoiceSettings({ auth: loggedInAuth(), bridge: readyBridge(), settings: async () => keys });
  const out = await vs.prepare();
  assert.equal(out.status, 'ready');
  assert.equal(out.selected, 'no996');
  assert.equal(out.automatic, true);
  assert.equal(keys.snapshot().use.tts, 'no996');
});

test('never overwrites an explicit third-party choice', async () => {
  const keys = memorySettings({ use: { tts: 'openai' }, model: { tts: 'gpt-tts' } });
  const vs = createNo996VoiceSettings({ auth: loggedInAuth(), bridge: readyBridge(), settings: async () => keys });
  const out = await vs.prepare();
  assert.equal(out.selected, 'openai');
  assert.equal(out.automatic, false);
});

test('explicit none is remembered and blocks auto', async () => {
  const keys = memorySettings();
  const vs = createNo996VoiceSettings({ auth: loggedInAuth(), bridge: readyBridge(), settings: async () => keys });
  let reply = await vs.choose({ verb: 'tts', provider: '' }, async () => ({ status: 200, value: { providers: [] } }));
  assert.equal(keys.snapshot().use.tts, undefined);
  const out = await vs.prepare();
  assert.equal(out.selected, null);
  assert.equal(reply.value.no996VoiceAutomatic, false);
});

test('signed-out never auto-selects', async () => {
  const keys = memorySettings();
  const vs = createNo996VoiceSettings({
    auth: signedOutAuth(),
    bridge: { async refreshReady() { return false; }, async listCatalog() { throw new Error('no'); } },
    settings: async () => keys,
  });
  const out = await vs.prepare();
  assert.equal(out.status, 'signed-out');
  assert.equal(out.selected, null);
});
