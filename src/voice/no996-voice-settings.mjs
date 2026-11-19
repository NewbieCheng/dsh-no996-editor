import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const AUTO_MODEL = '__no996_voice_auto__';
const NONE_MODEL = '__no996_voice_none__';

function loadSettings() {
  const root = dirname(require.resolve('openfilm/package.json'));
  return import(pathToFileURL(join(root, 'studio/server/keys.mjs')).href);
}

export function createNo996VoiceSettings({ auth, bridge, settings = loadSettings, now = Date.now } = {}) {
  if (!auth || typeof auth.status !== 'function') throw new TypeError('auth.status is required');
  if (!bridge || typeof bridge.refreshReady !== 'function' || typeof bridge.listCatalog !== 'function') {
    throw new TypeError('bridge with refreshReady/listCatalog is required');
  }
  let snapshot;
  let pending;
  let generation = 0;

  function invalidate() {
    generation += 1;
    snapshot = undefined;
    pending = undefined;
  }

  async function check(force = false) {
    if (pending) return pending;
    if (!force && snapshot && now() < snapshot.until) return snapshot.status;
    const version = generation;
    const promise = (async () => {
      let status = 'unavailable';
      try {
        const ready = await bridge.refreshReady();
        if (ready) {
          try {
            const catalog = await bridge.listCatalog(AbortSignal.timeout(5000));
            const voices = [...(catalog?.clones ?? []), ...(catalog?.platform ?? [])];
            status = voices.length ? 'ready' : 'unavailable';
          } catch {
            status = 'unavailable';
          }
        } else {
          try {
            const account = await auth.status();
            status = !account?.loggedIn || account?.guest ? 'signed-out' : 'unavailable';
          } catch {
            status = 'unavailable';
          }
        }
      } catch {
        status = 'unavailable';
      }
      if (version !== generation) return check(false);
      snapshot = { status, until: now() + 30_000 };
      return status;
    })();
    pending = promise;
    try {
      return await promise;
    } finally {
      if (pending === promise) pending = undefined;
    }
  }

  function isAutoSelected(s) {
    return s.use?.tts === 'no996' && s.model?.tts === AUTO_MODEL;
  }

  function isExplicitNone(s) {
    return !s.use?.tts && s.model?.tts === NONE_MODEL;
  }

  async function prepare({ force = false } = {}) {
    const status = await check(force);
    const keys = await settings();
    let s = await keys.readSettings();
    const eligible = status === 'ready' && !s.use?.tts && s.model?.tts !== NONE_MODEL && !s.off?.includes('no996');
    if (eligible) {
      s = await keys.changeSettings(current => {
        if (current.use?.tts || current.model?.tts === NONE_MODEL || current.off?.includes('no996')) return;
        current.use.tts = 'no996';
        current.model.tts = AUTO_MODEL;
      });
    }
    return { status, selected: s.use?.tts ?? null, automatic: isAutoSelected(s) };
  }

  async function choose(input, callStudio) {
    if (!input || input.verb !== 'tts' || typeof input.provider !== 'string' ||
        (input.model !== undefined && typeof input.model !== 'string') ||
        (input.no996VoiceAuto !== undefined && typeof input.no996VoiceAuto !== 'boolean')) {
      return { status: 400, value: { error: '配音模型选择无效。' } };
    }
    if (input.no996VoiceAuto && input.provider !== '') {
      return { status: 400, value: { error: '配音模型选择无效。' } };
    }
    if (typeof callStudio !== 'function') throw new TypeError('callStudio is required');
    if (input.no996VoiceAuto) {
      const keys = await settings();
      await keys.changeSettings(s => {
        s.off = (s.off ?? []).filter(id => id !== 'no996');
        s.use.tts = 'no996';
        s.model.tts = AUTO_MODEL;
      });
      return state(callStudio);
    }
    if (input.provider === '') {
      const keys = await settings();
      await keys.changeSettings(s => {
        delete s.use.tts;
        s.model.tts = NONE_MODEL;
      });
      return state(callStudio);
    }
    const { status } = await prepare();
    if (input.provider === 'no996' && status !== 'ready') {
      return { status: 409, value: { error: '不加班配音尚未就绪，请先登录不加班账号后重试。' } };
    }
    const reply = await callStudio('PUT', '/api/providers/use', {
      verb: 'tts',
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
    });
    if (reply.status !== 200) return reply;
    return state(callStudio);
  }

  async function state(callStudio, { force = false } = {}) {
    if (typeof callStudio !== 'function') throw new TypeError('callStudio is required');
    const choice = await prepare({ force });
    const reply = await callStudio('GET', '/api/providers');
    if (reply.status !== 200 || !reply.value || !Array.isArray(reply.value.providers)) return reply;
    const { value } = reply;
    const providers = value.providers.map(p => (p.id === 'no996' ? {
      ...p,
      no996VoiceStatus: choice.status,
      no996VoiceDefault: choice.automatic && choice.selected === 'no996' && value.use?.tts === 'no996',
    } : p));
    return {
      ...reply,
      value: {
        ...value,
        providers,
        no996VoiceAutomatic: choice.automatic,
      },
    };
  }

  return { state, choose, prepare, invalidate, check };
}

export const __testing = { AUTO_MODEL, NONE_MODEL };
