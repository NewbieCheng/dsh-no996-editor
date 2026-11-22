/**
 * DSH Web capability providers (`no996-search` & `no996-fetch`) backed by
 * 不加班 workbench `/v1/tools/web_search` & `/v1/tools/web_fetch`.
 *
 * Uses the Host's protected default API Key (`sk-no996-...`), falling back to
 * workbench JWT. Never performs network calls inside `available()`.
 */

function text(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function makeWebError(message, code = 'PROVIDER_FAILED') {
  const err = new Error(message);
  err.name = 'WebError';
  err.code = code;
  return err;
}

export function createNo996WebProviders({ auth, fetchImpl = globalThis.fetch, onWalletDirty } = {}) {
  const base = String(auth?.baseUrl || '').replace(/\/+$/, '');
  let ready = false;
  let probing = false;

  async function refreshReady() {
    if (!auth || auth.dev || auth.guest) {
      ready = false;
      return false;
    }
    try {
      const s = await auth.status?.();
      ready = Boolean(s?.loggedIn && !s?.guest && !s?.dev);
      return ready;
    } catch {
      ready = false;
      return false;
    }
  }

  function available() {
    if (!auth || auth.dev || auth.guest) return false;
    if (!ready && !probing) {
      probing = true;
      void refreshReady().finally(() => { probing = false; });
    }
    return ready;
  }

  async function resolveBearer({ forceRefresh = false } = {}) {
    if (!auth || auth.dev || auth.guest) {
      throw makeWebError('请先登录正式不加班账号后再使用平台联网服务', 'UNAVAILABLE');
    }
    const jwt = forceRefresh && typeof auth.refreshTokenSession === 'function'
      ? await auth.refreshTokenSession()
      : await auth.accessToken?.();
    if (!jwt) throw makeWebError('请先登录不加班账号', 'UNAVAILABLE');
    return jwt;
  }

  async function postV1(path, body, signal) {
    let bearer = await resolveBearer();
    const doPost = async (token) => {
      try {
        return await fetchImpl(`${base}${path}`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw makeWebError('请求已取消', 'CANCELLED');
        throw makeWebError('无法连接不加班联网服务', 'PROVIDER_FAILED');
      }
    };
    let res = await doPost(bearer);
    if (res.status === 401 && typeof auth?.refreshTokenSession === 'function') {
      const refreshed = await auth.refreshTokenSession().catch(() => null);
      if (refreshed) {
        bearer = refreshed;
        res = await doPost(bearer);
      }
    }
    const raw = await res.text().catch(() => '');
    let json = {};
    try { json = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    if (!res.ok) {
      const msg = String(json?.error?.message || json?.message || `联网服务返回 HTTP ${res.status}`);
      throw makeWebError(msg, res.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_FAILED');
    }
    return json?.data !== undefined ? json.data : json;
  }

  const searchProvider = {
    id: 'no996-search',
    available,
    async search(request, signal) {
      const maxResults = Number.isFinite(request?.maxResults) && request.maxResults > 0
        ? Math.min(20, Math.round(request.maxResults))
        : 8;
      const data = await postV1('/v1/tools/web_search', {
        query: String(request?.query || ''),
        max_results: maxResults,
      }, signal);
      onWalletDirty?.('web-search');
      const items = Array.isArray(data?.results) ? data.results : Array.isArray(data?.items) ? data.items : [];
      const sources = items
        .filter(item => item && text(item.url))
        .slice(0, maxResults)
        .map(item => ({
          url: text(item.url),
          ...(text(item.title) ? { title: text(item.title) } : {}),
          ...(text(item.snippet || item.content || item.summary) ? { snippet: text(item.snippet || item.content || item.summary) } : {}),
          ...(text(item.published_at || item.publishedAt) ? { publishedAt: text(item.published_at || item.publishedAt) } : {}),
        }));
      return {
        ...(text(data?.answer || data?.content) ? { content: text(data?.answer || data?.content) } : {}),
        sources,
        truncated: items.length > sources.length || Boolean(data?.truncated),
      };
    },
  };

  const fetchProvider = {
    id: 'no996-fetch',
    available,
    async fetch(request, signal) {
      const data = await postV1('/v1/tools/web_fetch', {
        url: String(request?.url || ''),
      }, signal);
      onWalletDirty?.('web-fetch');
      const content = String(data?.content || data?.markdown || data?.text || '');
      const kind = String(data?.content_type || '').toLowerCase().includes('html') ? 'html' : 'text';
      return {
        url: text(data?.url) || String(request?.url || ''),
        statusCode: Number.isFinite(Number(data?.status_code ?? data?.statusCode)) ? Number(data?.status_code ?? data?.statusCode) : 200,
        body: { kind, content },
        truncated: Boolean(data?.truncated),
      };
    },
  };

  return { searchProvider, fetchProvider, refreshReady };
}

/** Register no996 search + fetch providers onto optional DSH `ctx.web` via child fiber. */
export function registerNo996WebProvider(ctx, { auth, onWalletDirty, fetchImpl } = {}) {
  const { searchProvider, fetchProvider, refreshReady } = createNo996WebProviders({ auth, onWalletDirty, fetchImpl });
  void refreshReady();
  const stop = ctx.inject(['web'], (webCtx) => {
    if (typeof webCtx?.web?.registerSearchProvider === 'function') {
      webCtx.effect(() => webCtx.web.registerSearchProvider(searchProvider), 'no996: web search provider');
    }
    if (typeof webCtx?.web?.registerFetchProvider === 'function') {
      webCtx.effect(() => webCtx.web.registerFetchProvider(fetchProvider), 'no996: web fetch provider');
    }
  });
  return {
    searchProvider,
    fetchProvider,
    refreshReady,
    dispose: () => {
      try { stop?.(); } catch { /* already stopped */ }
    },
  };
}
