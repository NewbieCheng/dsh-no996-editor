/**
 * Workbench account session for OpenFilm.
 *
 * Tokens live only on the Host under `$DSH_HOME/no996-openfilm/workbench-auth.json`.
 * The browser never sees access/refresh tokens — status replies are booleans and
 * display fields only. Refresh is single-flight: concurrent waiters share one
 * POST /auth/refresh so a reused refresh token cannot revoke the family.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_WORKBENCH_BASE_URL = 'https://worker.bujiaban.top';

const SESSION_CHANNEL = 'app';
const BODY_LIMIT = 64 * 1024;

function normalizeBase(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_WORKBENCH_BASE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_WORKBENCH_BASE_URL;
    if (url.username || url.password || url.search || url.hash) return DEFAULT_WORKBENCH_BASE_URL;
    return url.origin;
  } catch {
    return DEFAULT_WORKBENCH_BASE_URL;
  }
}

function authFilePath(home) {
  return join(home, 'no996-openfilm', 'workbench-auth.json');
}

function isEmail(value) {
  return String(value || '').includes('@');
}

function accountFields(account) {
  const trimmed = String(account || '').trim();
  if (!trimmed) return {};
  return isEmail(trimmed) ? { email: trimmed.toLowerCase() } : { phone: trimmed };
}

function publicError(code, message, status = 400, details) {
  const error = new Error(message || code);
  error.code = code;
  error.status = status;
  if (details && typeof details === 'object') error.details = details;
  return error;
}

async function readJsonBody(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

export function createWorkbenchAuth({
  baseUrl = process.env.NO996_WORKBENCH_BASE_URL,
  home = process.env.DSH_HOME || join(homedir(), '.dsh'),
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  // Explicit opt-in for local development. It never creates tokens, never touches
  // the auth file, and never calls the workbench: a real session and a dev session
  // must be distinguishable at a glance, so nobody mistakes one for the other.
  dev = process.env.NO996_OPENFILM_DEV === '1',
} = {}) {
  const base = normalizeBase(baseUrl);
  const file = authFilePath(home);
  let session = null;
  let loaded = false;
  let loadPromise = null;
  let refreshGate = null;
  let ensureDefaultKeyGate = null;
  let writeQueue = Promise.resolve();
  // In-memory only: survives neither Host reload nor process restart. Used when the
  // real workbench is unreachable (e.g. abroad) so the shell can still be debugged.
  let guest = false;

  function sanitizeDefaultApiKey(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = Number(raw.id);
    if (!Number.isFinite(id) || id <= 0) return null;
    return {
      id,
      name: typeof raw.name === 'string' ? raw.name : 'no996-default',
      maskedKey: typeof raw.maskedKey === 'string' ? raw.maskedKey : '',
      secret: typeof raw.secret === 'string' ? raw.secret : '',
      rpmLimit: Number.isFinite(Number(raw.rpmLimit)) ? Number(raw.rpmLimit) : 60,
      dailyTokens: Number.isFinite(Number(raw.dailyTokens)) ? Number(raw.dailyTokens) : 0,
      ensuredAt: typeof raw.ensuredAt === 'string' ? raw.ensuredAt : '',
    };
  }

  function summarizeDefaultApiKey(record) {
    if (!record) {
      return { exists: false, ready: false, secretMissing: false, maskedKey: '', name: '', rpmLimit: 0, dailyTokens: 0 };
    }
    const hasSecret = typeof record.secret === 'string' && record.secret.length > 0;
    return {
      exists: true,
      ready: hasSecret,
      secretMissing: !hasSecret,
      id: record.id,
      name: record.name || 'no996-default',
      maskedKey: record.maskedKey || '',
      rpmLimit: record.rpmLimit || 60,
      dailyTokens: record.dailyTokens || 0,
      ensuredAt: record.ensuredAt || '',
    };
  }

  async function load() {
    if (loaded) return session;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      loaded = true;
      try {
        const raw = await readFile(file, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || typeof parsed.refreshToken !== 'string' || !parsed.refreshToken) {
          session = null;
          return null;
        }
        session = {
          accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : '',
          refreshToken: parsed.refreshToken,
          expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : '',
          userId: typeof parsed.userId === 'number' ? parsed.userId : 0,
          account: typeof parsed.account === 'string' ? parsed.account : '',
          displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
          defaultApiKey: sanitizeDefaultApiKey(parsed.defaultApiKey),
        };
        return session;
      } catch {
        session = null;
        return null;
      }
    })().finally(() => { loadPromise = null; });
    return loadPromise;
  }

  function persist(next) {
    loaded = true;
    session = next;
    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      if (!next) {
        await writeFile(tmp, 'null\n', { encoding: 'utf8', mode: 0o600 });
        await rename(tmp, file);
        return;
      }
      const payload = {
        version: 2,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        expiresAt: next.expiresAt || '',
        userId: next.userId || 0,
        account: next.account || '',
        displayName: next.displayName || '',
        ...(next.defaultApiKey ? { defaultApiKey: next.defaultApiKey } : {}),
        updatedAt: new Date(now()).toISOString(),
      };
      await writeFile(tmp, `${JSON.stringify(payload)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, file);
    }).catch(() => { /* disk failure must not break login UX */ });
    return writeQueue;
  }

  async function workbench(path, { method = 'GET', body, token, headers } = {}) {
    const init = {
      method,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(headers || {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, init);
    } catch {
      throw publicError('WORKBENCH_UNREACHABLE', '无法连接账号服务，请检查网络后重试', 503);
    }
    const json = await readJsonBody(response);
    if (!response.ok) {
      const err = json?.error || {};
      throw publicError(
        String(err.code || 'WORKBENCH_ERROR'),
        String(err.message || `账号服务返回 ${response.status}`),
        response.status,
        err.details && typeof err.details === 'object' ? err.details : undefined,
      );
    }
    return json?.data !== undefined ? json.data : json;
  }

  async function applyTokens(data, { account, displayName } = {}) {
    if (!data || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
      throw publicError('AUTH_TOKEN_MISSING', '登录成功但未收到会话令牌', 502);
    }
    const nextUserId = typeof data.user_id === 'number' ? data.user_id : 0;
    const sameUser = session?.defaultApiKey && (session.userId === 0 || nextUserId === 0 || session.userId === nextUserId);
    const next = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: typeof data.expires_at === 'string' ? data.expires_at : '',
      userId: nextUserId,
      account: account || session?.account || '',
      displayName: displayName || session?.displayName || '',
      defaultApiKey: sameUser ? session.defaultApiKey : null,
    };
    await persist(next);
    return next;
  }

  async function saveDefaultApiKey(apiKeyMeta, plaintextSecret = '') {
    await load();
    if (!session?.refreshToken || !apiKeyMeta || typeof apiKeyMeta !== 'object') return null;
    const prevSecret = session.defaultApiKey?.id === Number(apiKeyMeta.api_key_id) ? session.defaultApiKey.secret : '';
    const record = sanitizeDefaultApiKey({
      id: Number(apiKeyMeta.api_key_id || apiKeyMeta.id || 0),
      name: typeof apiKeyMeta.key_name === 'string' ? apiKeyMeta.key_name : 'no996-default',
      maskedKey: typeof apiKeyMeta.masked_key === 'string' ? apiKeyMeta.masked_key : '',
      secret: typeof plaintextSecret === 'string' && plaintextSecret ? plaintextSecret : prevSecret,
      rpmLimit: Number(apiKeyMeta.rpm_limit || 60),
      dailyTokens: Number(apiKeyMeta.daily_tokens || 0),
      ensuredAt: new Date(now()).toISOString(),
    });
    if (!record) return null;
    await persist({ ...session, defaultApiKey: record });
    return record;
  }

  async function workbenchAuthed(path, options = {}) {
    const token = await apiMethods.accessToken();
    if (!token) throw publicError('AUTH_REQUIRED', '请先登录', 401);
    try {
      return await workbench(path, { ...options, token });
    } catch (error) {
      if (error?.status === 401 && session?.refreshToken) {
        const refreshed = await refresh();
        if (refreshed?.accessToken) {
          return await workbench(path, { ...options, token: refreshed.accessToken });
        }
      }
      throw error;
    }
  }

  async function refreshLocked() {
    await load();
    if (!session?.refreshToken) throw publicError('AUTH_REQUIRED', '请先登录', 401);
    const previous = session.refreshToken;
    try {
      const data = await workbench('/api/v1/auth/refresh', {
        method: 'POST',
        body: { refresh_token: previous },
      });
      return await applyTokens(data, { account: session.account, displayName: session.displayName });
    } catch (error) {
      // Any refresh failure means this Host no longer has a usable session.
      // Clear locally so the panel returns to the login gate (reuse/expiry/network).
      await persist(null);
      throw error;
    }
  }

  async function refresh() {
    if (refreshGate) return refreshGate;
    refreshGate = refreshLocked().finally(() => { refreshGate = null; });
    return refreshGate;
  }

  function devSnapshot() {
    return {
      loggedIn: true,
      dev: true,
      baseUrl: 'dev',
      userId: 0,
      account: 'dev@local',
      displayName: '开发模式',
      expiresAt: '',
    };
  }

  function guestSnapshot() {
    return {
      loggedIn: true,
      guest: true,
      baseUrl: 'guest',
      userId: 0,
      account: 'guest@local',
      displayName: '游客',
      expiresAt: '',
    };
  }

  function zeroBalance({ guest: asGuest = false, asDev = false } = {}) {
    return {
      points_balance: 0,
      expert_points_balance: 0,
      period_points_balance: 0,
      period_expires_at: null,
      available_points: 0,
      ...(asDev ? { dev: true } : {}),
      ...(asGuest ? { guest: true } : {}),
    };
  }

  function statusSnapshot() {
    if (!session?.refreshToken) {
      return { loggedIn: false, baseUrl: base };
    }
    return {
      loggedIn: true,
      baseUrl: base,
      userId: session.userId || 0,
      account: session.account || '',
      displayName: session.displayName || '',
      expiresAt: session.expiresAt || '',
    };
  }

  const apiMethods = {
    baseUrl: base,
    dev,
    get guest() { return guest === true; },
    async status() {
      if (dev) return devSnapshot();
      if (guest) return guestSnapshot();
      await load();
      if (!session?.refreshToken) return statusSnapshot();
      // Soft-probe: if access looks stale, refresh once; failure → logged out.
      const expiresMs = session.expiresAt ? Date.parse(session.expiresAt) : NaN;
      if (Number.isFinite(expiresMs) && expiresMs - now() < 60_000) {
        try { await refresh(); } catch { /* statusSnapshot after clear */ }
      } else if (!session.accessToken) {
        try { await refresh(); } catch { /* statusSnapshot after clear */ }
      }
      return statusSnapshot();
    },
    /** Enter a no-token guest session (Host memory only). No workbench call. */
    async enterGuest() {
      if (dev) return devSnapshot();
      await load();
      // A real session already opens the workbench; do not mask it with guest.
      if (session?.refreshToken) return statusSnapshot();
      guest = true;
      return guestSnapshot();
    },
    async captcha(type = 'click') {
      // Default matches workbench / 清流: click challenge, not typed image code.
      const allowed = type === 'math' || type === 'image' ? type : 'click';
      const data = await workbench(`/api/v1/auth/captcha?type=${allowed}`);
      // Never forward a development plaintext code to the browser.
      return {
        id: String(data?.id || ''),
        type: String(data?.type || allowed),
        svg: typeof data?.svg === 'string' ? data.svg : '',
        prompt: typeof data?.prompt === 'string' ? data.prompt : undefined,
        icon_target: typeof data?.icon_target === 'string' ? data.icon_target : undefined,
        sequence: Array.isArray(data?.sequence) ? data.sequence.filter(item => typeof item === 'string') : undefined,
      };
    },
    async login({ account, password, captchaId, captchaCode }) {
      const fields = accountFields(account);
      if (!fields.email && !fields.phone) throw publicError('AUTH_ACCOUNT_REQUIRED', '请输入手机号或邮箱', 400);
      if (typeof password !== 'string' || password.length < 6) throw publicError('AUTH_PASSWORD_REQUIRED', '密码至少 6 位', 400);
      const body = {
        ...fields,
        password,
        session_channel: SESSION_CHANNEL,
      };
      if (captchaId) body.captcha_id = String(captchaId);
      if (captchaCode) body.captcha_code = String(captchaCode);
      const data = await workbench('/api/v1/auth/login', { method: 'POST', body });
      await applyTokens(data, { account: fields.email || fields.phone || String(account).trim() });
      void apiMethods.ensureDefaultApiKey().catch(() => {});
      return statusSnapshot();
    },
    async requestVerificationCode({ account, purpose = 'register', captchaId, captchaCode, locale }) {
      const fields = accountFields(account);
      if (!fields.email && !fields.phone) throw publicError('AUTH_ACCOUNT_REQUIRED', '请输入邮箱', 400);
      if (!fields.email) throw publicError('AUTH_EMAIL_REQUIRED', '目前仅支持邮箱接收验证码', 400);
      const body = {
        target: fields.email,
        purpose: purpose === 'reset_password' || purpose === 'login' ? purpose : 'register',
        captcha_id: captchaId ? String(captchaId) : '',
        captcha_code: captchaCode ? String(captchaCode) : '',
      };
      if (locale) body.locale = String(locale);
      const data = await workbench('/api/v1/auth/verification-codes', { method: 'POST', body });
      return {
        target: typeof data?.target === 'string' ? data.target : fields.email,
        purpose: typeof data?.purpose === 'string' ? data.purpose : body.purpose,
        expiresAt: typeof data?.expires_at === 'string' ? data.expires_at : '',
      };
    },
    async register({ account, password, code, inviteCode, displayName }) {
      const fields = accountFields(account);
      if (!fields.email) throw publicError('AUTH_EMAIL_REQUIRED', '注册请使用邮箱', 400);
      if (typeof password !== 'string' || password.length < 6) throw publicError('AUTH_PASSWORD_REQUIRED', '密码至少 6 位', 400);
      if (!String(code || '').trim()) throw publicError('AUTH_CODE_REQUIRED', '请输入邮箱验证码', 400);
      if (!String(inviteCode || '').trim()) throw publicError('AUTH_INVITE_REQUIRED', '请输入邀请码', 400);
      const body = {
        email: fields.email,
        password,
        code: String(code).trim(),
        invite_code: String(inviteCode).trim(),
        session_channel: SESSION_CHANNEL,
      };
      if (displayName) body.display_name = String(displayName).trim();
      const data = await workbench('/api/v1/auth/register', { method: 'POST', body });
      await applyTokens(data, {
        account: fields.email,
        displayName: body.display_name || '',
      });
      void apiMethods.ensureDefaultApiKey().catch(() => {});
      return statusSnapshot();
    },
    async resetPassword({ account, code, newPassword }) {
      const fields = accountFields(account);
      if (!fields.email) throw publicError('AUTH_EMAIL_REQUIRED', '请使用邮箱重置密码', 400);
      if (!String(code || '').trim()) throw publicError('AUTH_CODE_REQUIRED', '请输入邮箱验证码', 400);
      if (typeof newPassword !== 'string' || newPassword.length < 6) throw publicError('AUTH_PASSWORD_REQUIRED', '新密码至少 6 位', 400);
      await workbench('/api/v1/auth/reset-password', {
        method: 'POST',
        body: {
          email: fields.email,
          code: String(code).trim(),
          new_password: newPassword,
        },
      });
      return { ok: true };
    },
    async logout() {
      if (dev) return devSnapshot();
      if (guest) {
        guest = false;
        return { loggedIn: false, baseUrl: base };
      }
      await load();
      const refreshToken = session?.refreshToken;
      const accessToken = session?.accessToken;
      await persist(null);
      if (refreshToken) {
        try {
          await workbench('/api/v1/auth/logout', {
            method: 'POST',
            body: { refresh_token: refreshToken },
            token: accessToken || undefined,
          });
        } catch { /* local clear already done */ }
      }
      return statusSnapshot();
    },
    /** Host-only: never expose to the browser. */
    async accessToken() {
      await load();
      if (!session?.refreshToken) return null;
      const expiresMs = session.expiresAt ? Date.parse(session.expiresAt) : NaN;
      if (!session.accessToken || (Number.isFinite(expiresMs) && expiresMs - now() < 60_000)) {
        await refresh();
      }
      return session?.accessToken || null;
    },
    /**
     * Current-space wallet balance from the workbench.
     * Same endpoint as 清流 `/api/billing/balance` and 工作台-web AccountPage.
     * Tokens never leave Host.
     */
    async balance() {
      if (dev) return zeroBalance({ asDev: true });
      if (guest) return zeroBalance({ guest: true });
      const token = await this.accessToken();
      if (!token) throw publicError('AUTH_REQUIRED', '请先登录', 401);
      const data = await workbench('/api/v1/account/balance', { token });
      const points = Number(data?.points_balance);
      const expert = Number(data?.expert_points_balance);
      const period = Number(data?.period_points_balance);
      const permanent = Number.isFinite(points) ? points : 0;
      const periodPoints = Number.isFinite(period) ? period : 0;
      return {
        points_balance: permanent,
        expert_points_balance: Number.isFinite(expert) ? expert : 0,
        period_points_balance: periodPoints,
        period_expires_at: typeof data?.period_expires_at === 'string' ? data.period_expires_at : null,
        // 可用 = 永久桶 + 本期桶（清流同口径；只看永久会把月度套餐判成 0）
        available_points: permanent + periodPoints,
      };
    },
    /** Host-only: authenticated JSON request against workbench with 1 automatic refresh retry. */
    async authedRequest(path, options = {}) {
      if (dev || guest) throw publicError('AUTH_REQUIRED', '请先登录正式不加班账号', 401);
      return await workbenchAuthed(path, options);
    },
    /** Safe summary for UI (never exposes the plaintext API Key secret). */
    async getDefaultApiKeySummary() {
      if (dev || guest) {
        return { exists: false, ready: false, secretMissing: false, maskedKey: '', name: '', rpmLimit: 0, dailyTokens: 0 };
      }
      await load();
      return summarizeDefaultApiKey(session?.defaultApiKey);
    },
    /** Host-only: returns plaintext secret for server-to-server /v1 calls. Never send to renderer. */
    async getDefaultApiKeySecret() {
      if (dev || guest) return null;
      await load();
      return session?.defaultApiKey?.secret || null;
    },
    /** Ensure user has a protected system default API Key and save plaintext locally on first issuance. */
    async ensureDefaultApiKey({ autoRotateIfMissingSecret = false } = {}) {
      if (dev || guest) {
        return { exists: false, ready: false, secretMissing: false, maskedKey: '', name: '', rpmLimit: 0, dailyTokens: 0 };
      }
      if (ensureDefaultKeyGate) return await ensureDefaultKeyGate;
      ensureDefaultKeyGate = (async () => {
        await load();
        if (!session?.refreshToken) throw publicError('AUTH_REQUIRED', '请先登录', 401);
        if (session.defaultApiKey?.secret) {
          return summarizeDefaultApiKey(session.defaultApiKey);
        }
        const data = await workbenchAuthed('/api/v1/me/api-keys/default', { method: 'POST' });
        const plaintext = typeof data?.api_key_plaintext === 'string' ? data.api_key_plaintext : '';
        const record = await saveDefaultApiKey(data?.api_key, plaintext);
        if (!record?.secret && autoRotateIfMissingSecret) {
          return await apiMethods.rotateDefaultApiKey();
        }
        return summarizeDefaultApiKey(record || session?.defaultApiKey);
      })().finally(() => { ensureDefaultKeyGate = null; });
      return await ensureDefaultKeyGate;
    },
    /** Explicitly rotate the protected system default API Key and persist new plaintext locally. */
    async rotateDefaultApiKey() {
      if (dev || guest) throw publicError('AUTH_REQUIRED', '请先登录正式不加班账号', 401);
      await load();
      if (!session?.refreshToken) throw publicError('AUTH_REQUIRED', '请先登录', 401);
      const data = await workbenchAuthed('/api/v1/me/api-keys/default/rotate', { method: 'POST' });
      const plaintext = typeof data?.api_key_plaintext === 'string' ? data.api_key_plaintext : '';
      const record = await saveDefaultApiKey(data?.api_key, plaintext);
      return summarizeDefaultApiKey(record || session?.defaultApiKey);
    },
  };
  return apiMethods;
}

export function parseAuthActionBody(raw, limit = BODY_LIMIT) {
  if (typeof raw !== 'string') throw publicError('INPUT', '无效请求', 400);
  if (Buffer.byteLength(raw, 'utf8') > limit) throw publicError('BODY_LIMIT', '请求过大', 413);
  let value;
  try { value = JSON.parse(raw || '{}'); } catch { throw publicError('INPUT', '无效 JSON', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw publicError('INPUT', '无效请求', 400);
  return value;
}
