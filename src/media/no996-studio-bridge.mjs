/**
 * Host-side bridge exposing No996 workbench capabilities to OpenFilm Studio's
 * added-provider (`vendor/providers/no996/provider.mjs`) under the existing
 * process symbol (`no996.openfilm.voice`).
 *
 * Uses the user's protected system default API Key (`sk-no996-...`) stored only
 * in Host when available, seamlessly falling back to the workbench JWT when
 * appropriate because `/v1/**` accepts dual-channel auth. Tokens/keys never
 * leave Host.
 */

import { createVoiceBridge, VOICE_BRIDGE } from '../voice/voice-bridge.mjs';

const MAX_TEXT = 4000;
const MEDIA_TIMEOUT_MS = 180_000;

const RATIO_SIZES = Object.freeze({
  '16:9': '1536x864',
  '9:16': '864x1536',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '4:3': '1408x1056',
  '3:4': '1056x1408',
  '1:1': '1024x1024',
  '21:9': '1680x720',
});

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function list(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

function landing(dir, out, ext) {
  const raw = text(out) || `${dir.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}`;
  const name = raw.replace(/\.[a-z0-9]{2,4}$/i, '');
  if (!name || name === '.' || name === '..' || /[/\\\u0000-\u001f]/.test(name)) {
    throw new Error('--out is a name (no folders, no extension), e.g. --out cover.');
  }
  return `assets/${dir}/${name}.${ext}`;
}

function publicError(code, message, status = 400) {
  return Object.assign(new Error(message || code), { code, status });
}

async function readJson(response) {
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { raw: raw.slice(0, 400) }; }
}

/**
 * @param {{
 *   auth: {
 *     accessToken: () => Promise<string|null>,
 *     status: () => Promise<{loggedIn?: boolean, guest?: boolean, dev?: boolean}>,
 *     getDefaultApiKeySecret?: () => Promise<string|null>,
 *     ensureDefaultApiKey?: () => Promise<{ready?: boolean}>,
 *     baseUrl: string,
 *     dev?: boolean,
 *   },
 *   fetchImpl?: typeof fetch,
 *   onWalletDirty?: (reason: string) => void,
 * }} deps
 */
export function createNo996StudioBridge({ auth, fetchImpl = globalThis.fetch, onWalletDirty } = {}) {
  const voiceBridge = createVoiceBridge({ auth, fetchImpl });
  const base = String(auth?.baseUrl || '').replace(/\/+$/, '');

  async function isReady() {
    if (auth?.dev === true) return true;
    try {
      const status = await auth.status();
      return status?.loggedIn === true && status?.guest !== true;
    } catch {
      return false;
    }
  }

  /** Use Host-only short-lived JWT (no static API Key stored on client). */
  async function resolveBearerToken({ forceRefresh = false } = {}) {
    const token = forceRefresh && typeof auth?.refreshTokenSession === 'function'
      ? await auth.refreshTokenSession()
      : await auth.accessToken();
    if (!token) throw publicError('AUTH_REQUIRED', '请先登录不加班账号', 401);
    return token;
  }

  async function authedV1(path, { method = 'POST', body, signal } = {}) {
    let bearer = await resolveBearerToken();
    const doFetch = async (token) => {
      try {
        return await fetchImpl(`${base}${path}`, {
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        throw publicError('WORKBENCH_UNREACHABLE', '无法连接不加班网关，请检查网络后重试', 503);
      }
    };
    let response = await doFetch(bearer);
    if (response.status === 401 && typeof auth?.refreshTokenSession === 'function') {
      const refreshed = await auth.refreshTokenSession().catch(() => null);
      if (refreshed) {
        bearer = refreshed;
        response = await doFetch(bearer);
      }
    }
    const json = await readJson(response);
    if (!response.ok) {
      const err = json?.error || {};
      const message = String(err.message || json?.message || `请求失败 (${response.status})`);
      if (response.status === 402 || /balance|quota|insufficient|积分/i.test(message)) {
        throw publicError('balance', '不加班积分不足，请先充值后再调用。', 402);
      }
      if (response.status === 429) {
        const retryAfter = response.headers?.get?.('retry-after');
        throw publicError(
          'RATE_LIMITED',
          retryAfter ? `请求过于频繁，请 ${retryAfter} 秒后重试。` : '请求频率达到上限，请稍后再试。',
          429,
        );
      }
      throw publicError(String(err.code || `HTTP_${response.status}`), message, response.status);
    }
    return (json?.data && typeof json.data === 'object' && !Array.isArray(json.data)) ? json.data : json;
  }

  async function downloadBytes(url, signal) {
    const target = /^https?:\/\//i.test(url) ? url : `${base}${url.startsWith('/') ? url : `/${url}`}`;
    const headers = {};
    if (target.startsWith(base)) {
      const bearer = await resolveBearerToken().catch(() => null);
      if (bearer) headers.authorization = `Bearer ${bearer}`;
    }
    const res = await fetchImpl(target, { headers, signal });
    if (!res.ok) throw publicError('MEDIA_FETCH', `媒体资源下载失败 (${res.status})`, 502);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) throw publicError('MEDIA_EMPTY', '生成的媒体文件为空', 502);
    return buf;
  }

  async function generateImage({ prompt, ratio = '3:2', size, model = 'auto', out } = {}, ctx) {
    const cleanPrompt = text(prompt);
    if (!cleanPrompt) throw new Error('--prompt is required.');
    const resolvedSize = text(size) || RATIO_SIZES[text(ratio)] || '1536x1024';
    const path = landing('image', out, 'png');
    ctx?.say?.('正在通过不加班网关生成图片…');
    const body = await authedV1('/v1/images/generations', {
      method: 'POST',
      body: {
        model: text(model) || 'auto',
        prompt: cleanPrompt.slice(0, MAX_TEXT),
        n: 1,
        size: resolvedSize,
        response_format: 'b64_json',
      },
      signal: ctx?.signal ?? AbortSignal.timeout(MEDIA_TIMEOUT_MS),
    });

    const item = Array.isArray(body?.data) ? body.data[0] : (Array.isArray(body) ? body[0] : body);
    let bytes;
    if (typeof item?.b64_json === 'string' && item.b64_json) {
      bytes = new Uint8Array(Buffer.from(item.b64_json, 'base64'));
    } else if (typeof item?.url === 'string' && item.url) {
      bytes = await downloadBytes(item.url, ctx?.signal ?? AbortSignal.timeout(MEDIA_TIMEOUT_MS));
    } else {
      throw publicError('IMAGE_EMPTY', '图片生成接口未返回图像内容', 502);
    }

    onWalletDirty?.('image');
    const usedModel = text(body?.model) || text(model) || 'auto';
    return {
      files: [{ path, bytes }],
      index: [{
        src: path,
        kind: 'image',
        from: { mode: 'gen', prompt: cleanPrompt, provider: 'no996', model: usedModel },
      }],
      receipt: {
        provider: 'no996',
        model: usedModel,
        src: path,
        size: resolvedSize,
      },
      cost: { note: 'Billed by 不加班 workbench' },
    };
  }

  async function runWebSearch(args, ctx) {
    const queries = list(args?.query).slice(0, 3);
    if (!queries.length) throw new Error('--query is required.');
    ctx?.say?.('正在使用不加班联网搜索…');
    const rows = await Promise.all(queries.map(async (query) => {
      const res = await authedV1('/v1/tools/web_search', {
        method: 'POST',
        body: { query, max_results: 8 },
        signal: ctx?.signal ?? AbortSignal.timeout(60_000),
      });
      const items = Array.isArray(res?.results) ? res.results : Array.isArray(res?.items) ? res.items : [];
      return {
        query,
        hits: items.map((r) => ({
          title: text(r?.title),
          url: text(r?.url),
          ...(text(r?.published_at || r?.publishedAt) ? { publishedAt: text(r.published_at || r.publishedAt) } : {}),
          excerpt: text(r?.snippet || r?.content || r?.summary).slice(0, 300),
        })),
      };
    }));
    onWalletDirty?.('web-search');
    const receipt = rows.length === 1
      ? { provider: 'no996', ...rows[0] }
      : { provider: 'no996', searches: rows };
    return { files: [], index: [], receipt, cost: { note: 'Billed by 不加班 workbench' } };
  }

  async function runVideo(args, ctx) {
    const cleanPrompt = text(args?.prompt);
    if (!cleanPrompt) throw new Error('--prompt is required.');
    try {
      const res = await authedV1('/v1/videos/generations', {
        method: 'POST',
        body: {
          model: text(ctx?.model) || 'auto',
          prompt: cleanPrompt,
          ...(Number.isFinite(Number(args?.duration)) ? { duration: Number(args.duration) } : {}),
          ...(text(args?.['aspect-ratio'] || args?.ratio) ? { aspect_ratio: text(args?.['aspect-ratio'] || args?.ratio) } : {}),
        },
        signal: ctx?.signal ?? AbortSignal.timeout(MEDIA_TIMEOUT_MS),
      });
      onWalletDirty?.('video');
      const taskId = text(res?.task_id || res?.id);
      return {
        files: [],
        index: [],
        receipt: { provider: 'no996', status: text(res?.status) || 'submitted', ...(taskId ? { task_id: taskId } : {}) },
        cost: { note: 'Billed by 不加班 workbench' },
      };
    } catch (error) {
      if (error?.status === 404 || error?.status === 501 || error?.status === 503 || error?.code === 'VIDEO_GENERATION_NOT_CONFIGURED') {
        throw publicError(
          'VIDEO_NOT_CONFIGURED',
          '平台尚未配置默认视频生成模型，请在管理员后台配置视频模型，或在 Studio 设置中绑定自有服务 API Key。',
          503,
        );
      }
      throw error;
    }
  }

  const api = {
    ready: () => voiceBridge.ready(),
    refreshReady: () => voiceBridge.refreshReady(),
    listCatalog: (signal) => voiceBridge.listCatalog(signal),
    libraryVoicesPayload: () => voiceBridge.libraryVoicesPayload(),
    synthesize: async (voiceId, said, signal) => {
      const out = await voiceBridge.synthesize(voiceId, said, signal);
      onWalletDirty?.('tts');
      return out;
    },
    generateImage,
    async run(verb, args, ctx) {
      if (!(await isReady())) throw publicError('AUTH_REQUIRED', '请先登录不加班账号后再调用平台能力', 401);
      if (verb === 'voice') return voiceBridge.run('voice', args, ctx);
      if (verb === 'tts') {
        const res = await voiceBridge.run('tts', args, ctx);
        onWalletDirty?.('tts');
        return res;
      }
      if (verb === 'image') return generateImage(args, ctx);
      if (verb === 'web-search') return runWebSearch(args, ctx);
      if (verb === 'video') return runVideo(args, ctx);
      throw new Error(`不加班 does not do ${verb}.`);
    },
  };

  return api;
}

export { VOICE_BRIDGE };
