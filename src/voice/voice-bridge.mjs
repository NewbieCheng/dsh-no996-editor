/**
 * Host-side bridge that makes 不加班 look like an OpenFilm media provider.
 *
 * Reuses the workbench contracts the web app already calls:
 *   GET  /v1/audio/voices
 *   GET  /api/v1/models/default-tts
 *   POST /api/v1/ai/audio/speech
 *
 * Tokens stay in workbench-auth; Studio's added provider only sees this bridge
 * via `globalThis[Symbol.for('no996.openfilm.voice')]`.
 */

export const VOICE_BRIDGE = Symbol.for('no996.openfilm.voice');

const MAX_TEXT = 4000;
const SPEECH_TIMEOUT_MS = 600_000;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function needed(args, flag) {
  const value = text(args?.[flag]);
  if (!value) throw new Error(`--${flag} is required.`);
  return value;
}

function landing(dir, out, ext) {
  const name = text(out).replace(/\.[a-z0-9]{2,4}$/i, '');
  if (!name || name === '.' || name === '..' || /[/\\\u0000-\u001f]/.test(name)) {
    throw new Error('--out is a name (no folders, no extension), e.g. --out intro.');
  }
  return `assets/${dir}/${name}.${ext}`;
}

function wavSeconds(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) return 0;
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  if (!channels || !rate || !bits) return 0;
  const dataBytes = Math.max(0, bytes.length - 44);
  return Math.round((dataBytes / (channels * (bits / 8) * rate)) * 1000) / 1000;
}

function publicError(code, message, status = 400) {
  return Object.assign(new Error(message || code), { code, status });
}

/**
 * @param {{
 *   auth: { accessToken: () => Promise<string|null>, status: () => Promise<{loggedIn?: boolean, guest?: boolean, dev?: boolean}>, baseUrl: string, dev?: boolean },
 *   fetchImpl?: typeof fetch,
 * }} deps
 */
export function createVoiceBridge({ auth, fetchImpl = globalThis.fetch } = {}) {
  if (!auth || typeof auth.accessToken !== 'function' || typeof auth.status !== 'function') {
    throw new TypeError('auth with accessToken/status is required');
  }
  const base = String(auth.baseUrl || '').replace(/\/+$/, '');

  async function authed(path, { method = 'GET', body, signal, accept } = {}) {
    const token = await auth.accessToken();
    if (!token) throw publicError('AUTH_REQUIRED', '请先登录不加班账号', 401);
    const headers = {
      accept: accept || 'application/json',
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    };
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw publicError('WORKBENCH_UNREACHABLE', '无法连接账号服务，请检查网络后重试', 503);
    }
    return response;
  }

  async function readJson(response) {
    const raw = await response.text();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return { raw: raw.slice(0, 400) }; }
  }

  /** Whether Studio should treat no996 as connected. Guests cannot spend voice quota. */
  async function isReady() {
    if (auth.dev === true) return true;
    try {
      const status = await auth.status();
      return status?.loggedIn === true && status?.guest !== true;
    } catch {
      return false;
    }
  }

  /**
   * Clones (ready) + platform voices, same shape the workbench picker uses.
   * @returns {Promise<{ clones: Array<{voiceId:string,name:string,language:string|null,description:string|null,kind:'clone'|'platform'}>, platform: typeof clones }>}
   */
  async function listCatalog(signal) {
    const [cloneRes, platformRes] = await Promise.all([
      authed('/v1/audio/voices', { signal }),
      authed('/api/v1/models/default-tts', { signal }).catch(() => null),
    ]);

    const clonesJson = await readJson(cloneRes);
    if (!cloneRes.ok) {
      const err = clonesJson?.error || {};
      throw publicError(String(err.code || 'VOICE_LIST'), String(err.message || `音色列表失败 ${cloneRes.status}`), cloneRes.status);
    }
    const rows = Array.isArray(clonesJson?.data) ? clonesJson.data
      : Array.isArray(clonesJson) ? clonesJson : [];
    const clones = rows
      .filter((row) => row && row.ready_for_synthesis === true && text(row.voice_id))
      .map((row) => ({
        voiceId: text(row.voice_id),
        name: text(row.display_name) || text(row.voice_id),
        language: text(row.language_hint) || null,
        description: '我的复刻音色',
        kind: /** @type {const} */ ('clone'),
        gender: null,
      }));

    let platform = [];
    if (platformRes?.ok) {
      const body = await readJson(platformRes);
      const data = body?.data && typeof body.data === 'object' ? body.data : body;
      const list = Array.isArray(data?.platform_voices) ? data.platform_voices : [];
      platform = list
        .filter((row) => row && text(row.id))
        .map((row) => ({
          voiceId: text(row.id),
          name: text(row.label) || text(row.id),
          language: 'zh',
          description: '平台音色',
          kind: /** @type {const} */ ('platform'),
          gender: null,
        }));
    }

    return { clones, platform };
  }

  /** OpenFilm `get voice` receipt shape. */
  async function runVoice(args, ctx) {
    const limit = Math.min(100, Math.max(1, Math.round(Number(args?.limit) || 40)));
    const language = text(args?.language).toLowerCase();
    const gender = text(args?.gender).toLowerCase().slice(0, 1);
    const prompt = text(args?.prompt).toLowerCase();
    const { clones, platform } = await listCatalog(ctx?.signal);
    let voices = [...clones, ...platform];
    if (language) voices = voices.filter((v) => !v.language || String(v.language).toLowerCase().startsWith(language));
    if (gender) voices = voices.filter((v) => !v.gender || v.gender === gender);
    if (prompt) {
      voices = voices.filter((v) => [v.name, v.description, v.voiceId].some((s) => String(s || '').toLowerCase().includes(prompt)));
    }
    voices = voices.slice(0, limit);
    return {
      files: [],
      index: [],
      receipt: {
        provider: 'no996',
        voices: voices.map((v) => ({
          voiceId: v.voiceId,
          name: v.name,
          language: v.language,
          gender: v.gender,
          description: v.description,
        })),
      },
    };
  }

  async function synthesize(voiceId, said, signal) {
    const response = await authed('/api/v1/ai/audio/speech', {
      method: 'POST',
      body: {
        input: said.slice(0, MAX_TEXT),
        voice: voiceId,
        response_format: 'wav',
      },
      signal: signal ?? AbortSignal.timeout(SPEECH_TIMEOUT_MS),
    });
    const json = await readJson(response);
    if (!response.ok) {
      const err = json?.error || {};
      const message = String(err.message || json?.message || `配音失败 ${response.status}`);
      if (response.status === 402 || /balance|quota|积分/i.test(message)) {
        throw Object.assign(new Error('不加班积分不足，请先充值后再配音。'), { code: 'balance' });
      }
      throw publicError(String(err.code || 'SPEECH'), message, response.status);
    }
    const mediaPath = text(json?.url);
    const sourceUrl = text(json?.source_url);
    if (!mediaPath && !sourceUrl) throw publicError('SPEECH_EMPTY', '语音合成未返回音频地址', 502);

    const candidates = [];
    if (sourceUrl) candidates.push(sourceUrl);
    if (mediaPath) {
      if (/^https?:\/\//i.test(mediaPath)) candidates.push(mediaPath);
      else candidates.push(`${base}${mediaPath.startsWith('/') ? mediaPath : `/${mediaPath}`}`);
    }

    let lastError = null;
    for (const url of candidates) {
      try {
        const token = await auth.accessToken();
        const audio = await fetchImpl(url, {
          headers: token && url.startsWith(base) ? { authorization: `Bearer ${token}` } : {},
          signal,
        });
        if (!audio.ok) {
          lastError = new Error(`音频拉取失败（${audio.status}）`);
          continue;
        }
        const buf = new Uint8Array(await audio.arrayBuffer());
        if (!buf.length) {
          lastError = new Error('配音音频为空');
          continue;
        }
        return buf;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError || publicError('SPEECH_FETCH', '无法下载配音音频', 502);
  }

  async function runTts(args, ctx) {
    const voice = needed(args, 'voice');
    const said = needed(args, 'text');
    const path = landing('audio/vo', args.out, 'wav');
    ctx?.say?.('正在用不加班账号合成配音…');
    const bytes = await synthesize(voice, said, ctx?.signal);
    const dur = wavSeconds(bytes) || undefined;
    return {
      files: [{ path, bytes }],
      index: [{
        src: path,
        kind: 'audio',
        ...(dur ? { dur } : {}),
        text: said,
        voice,
        from: { mode: 'synth', text: said, voice, provider: 'no996', model: 'workbench-tts' },
      }],
      receipt: { provider: 'no996', model: 'workbench-tts', src: path, ...(dur ? { dur } : {}), voice },
      cost: { note: 'Billed by 不加班 workbench' },
    };
  }

  /**
   * Shape for /api/library/voices merge: only no996 entries.
   * @returns {Promise<{ version: number, providers: object[], voices: object[] }>}
   */
  async function libraryVoicesPayload() {
    const ready = await isReady();
    if (!ready) {
      return {
        version: 1,
        providers: [{ id: 'no996', name: '不加班', models: [{ id: 'workbench-tts', name: '不加班配音' }] }],
        voices: [],
      };
    }
    const { clones, platform } = await listCatalog();
    const voices = [
      ...clones.map((v) => ({
        provider: 'no996',
        id: v.voiceId,
        name: v.name,
        description: v.description,
        gender: v.gender,
        age: null,
        language: v.language,
        accent: null,
        tags: ['mine', 'clone'],
        sample: null,
        featured: true,
        uses: null,
      })),
      ...platform.map((v) => ({
        provider: 'no996',
        id: v.voiceId,
        name: v.name,
        description: v.description,
        gender: null,
        age: null,
        language: v.language,
        accent: null,
        tags: ['platform'],
        sample: null,
        featured: true,
        uses: null,
      })),
    ];
    return {
      version: 1,
      providers: [{ id: 'no996', name: '不加班', models: [{ id: 'workbench-tts', name: '不加班配音' }] }],
      voices,
    };
  }

  const api = {
    ready: () => {
      // Synchronous probe for provider.ready(); prefer last status snapshot.
      // Studio may call this often; avoid network. Host updates via status() elsewhere.
      return api._ready === true || auth.dev === true;
    },
    _ready: false,
    async refreshReady() {
      api._ready = await isReady();
      return api._ready;
    },
    async run(verb, args, ctx) {
      if (!(await isReady())) throw publicError('AUTH_REQUIRED', '请先登录不加班账号后再配音', 401);
      if (verb === 'voice') return runVoice(args, ctx);
      if (verb === 'tts') return runTts(args, ctx);
      throw new Error(`不加班 does not do ${verb}.`);
    },
    listCatalog,
    libraryVoicesPayload,
    synthesize,
  };

  return api;
}

/** Install / replace the process-wide bridge Studio's added provider calls. */
export function installVoiceBridgeGlobal(bridge) {
  if (!bridge || typeof bridge.ready !== 'function' || typeof bridge.run !== 'function') {
    throw new TypeError('bridge must expose ready() and run()');
  }
  globalThis[VOICE_BRIDGE] = bridge;
  return () => {
    if (globalThis[VOICE_BRIDGE] === bridge) delete globalThis[VOICE_BRIDGE];
  };
}
