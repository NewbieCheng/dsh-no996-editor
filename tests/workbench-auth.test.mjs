import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkbenchAuth, DEFAULT_WORKBENCH_BASE_URL, parseAuthActionBody } from '../src/auth/workbench-auth.mjs';
import { dispatchAuthAction, registerAuthBridge } from '../src/auth/auth-bridge.mjs';
import { Readable } from 'node:stream';

test('defaults to production workbench origin', () => {
  assert.equal(DEFAULT_WORKBENCH_BASE_URL, 'https://worker.bujiaban.top');
  const auth = createWorkbenchAuth({ home: join(tmpdir(), 'nof-auth-default'), baseUrl: undefined, fetchImpl: async () => { throw new Error('no'); } });
  assert.equal(auth.baseUrl, 'https://worker.bujiaban.top');
});

test('login persists tokens and status never returns them', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nof-auth-'));
  const calls = [];
  const auth = createWorkbenchAuth({
    home,
    baseUrl: 'https://worker.bujiaban.top',
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (String(url).endsWith('/api/v1/auth/login')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            data: {
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_at: '2099-01-01T00:00:00Z',
              user_id: 42,
            },
          }),
        };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
  const status = await auth.login({
    account: 'demo@example.com',
    password: 'StrongPass!9',
    captchaId: 'cid',
    captchaCode: 'AB12',
  });
  assert.equal(status.loggedIn, true);
  assert.equal(status.account, 'demo@example.com');
  assert.equal(status.access_token, undefined);
  assert.equal(status.refresh_token, undefined);
  assert.deepEqual(calls[0].body, {
    email: 'demo@example.com',
    password: 'StrongPass!9',
    session_channel: 'app',
    captcha_id: 'cid',
    captcha_code: 'AB12',
  });
  const saved = JSON.parse(await readFile(join(home, 'no996-openfilm', 'workbench-auth.json'), 'utf8'));
  assert.equal(saved.refreshToken, 'refresh-1');
  assert.equal(saved.accessToken, 'access-1');
});

test('refresh is single-flight and clears session on reuse', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nof-auth-'));
  let refreshCalls = 0;
  let resolveRefresh;
  const gate = new Promise(resolve => { resolveRefresh = resolve; });
  const auth = createWorkbenchAuth({
    home,
    now: () => Date.parse('2000-01-01T00:00:30Z'),
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/v1/auth/login')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({ data: { access_token: 'a0', refresh_token: 'r0', expires_at: '2000-01-01T00:00:00Z', user_id: 1 } }),
        };
      }
      if (String(url).endsWith('/api/v1/auth/refresh')) {
        refreshCalls += 1;
        await gate;
        return {
          ok: false, status: 401,
          text: async () => JSON.stringify({ error: { code: 'AUTH_REFRESH_TOKEN_REUSED', message: 'reused' } }),
        };
      }
      throw new Error(url);
    },
  });
  await auth.login({ account: 'a@b.com', password: 'StrongPass!9', captchaId: 'x', captchaCode: 'y' });
  const pending = Promise.allSettled([auth.accessToken(), auth.accessToken()]);
  resolveRefresh();
  const [a, b] = await pending;
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'rejected');
  assert.equal(a.reason.code, 'AUTH_REFRESH_TOKEN_REUSED');
  assert.equal(refreshCalls, 1);
  assert.equal((await auth.status()).loggedIn, false);
});

test('captcha defaults to click and strips development plaintext code', async () => {
  let requested = '';
  const auth = createWorkbenchAuth({
    home: await mkdtemp(join(tmpdir(), 'nof-auth-')),
    fetchImpl: async (url) => {
      requested = String(url);
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          data: { id: 'c1', type: 'click', svg: '<svg data-captcha-id="x"></svg>', code: 'SECRET', prompt: 'click_icon', icon_target: 'fish' },
        }),
      };
    },
  });
  const captcha = await auth.captcha();
  assert.match(requested, /type=click/);
  assert.equal(captcha.id, 'c1');
  assert.equal(captcha.type, 'click');
  assert.equal(captcha.prompt, 'click_icon');
  assert.equal(captcha.icon_target, 'fish');
  assert.equal(captcha.code, undefined);
});

test('auth bridge admits browser peer and never echoes tokens', async () => {
  let handler;
  const ctx = {
    connection: {
      browserPeer: { id: 'browser' },
      admit: ({ headers }) => (headers.cookie === 'valid' ? { peer: { id: 'browser' } } : { rejection: 401 }),
    },
    webServer: { register(route) { handler = route.handler; return () => {}; } },
  };
  const auth = {
    async status() { return { loggedIn: true, account: 'a@b.com', accessToken: 'leak', refreshToken: 'leak' }; },
    async login() { return { loggedIn: true, account: 'a@b.com' }; },
  };
  const authEvents = [];
  registerAuthBridge(ctx, {
    webOrigin: 'http://127.0.0.1:1234',
    auth,
    isDisposed: () => false,
    onAuthChanged: (action) => { authEvents.push(action); },
  });
  const req = Readable.from([Buffer.from(JSON.stringify({ action: 'status' }))]);
  req.method = 'POST';
  req.headers = { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234', cookie: 'valid', 'content-type': 'application/json' };
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; return this; }, end(value) { this.body = value; return this; } };
  await handler(req, res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.loggedIn, true);
  assert.equal(body.account, 'a@b.com');
  assert.equal(body.accessToken, undefined);
  assert.equal(body.refreshToken, undefined);
  assert.deepEqual(authEvents, []);

  const loginReq = Readable.from([Buffer.from(JSON.stringify({ action: 'login', account: 'a@b.com', password: 'StrongPass!9' }))]);
  loginReq.method = 'POST';
  loginReq.headers = { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234', cookie: 'valid', 'content-type': 'application/json' };
  const loginRes = { writeHead(status, headers) { this.status = status; this.headers = headers; return this; }, end(value) { this.body = value; return this; } };
  await handler(loginReq, loginRes);
  assert.equal(loginRes.status, 200);
  assert.deepEqual(authEvents, ['login']);
});

test('dispatchAuthAction routes register and verification', async () => {
  const seen = [];
  const auth = {
    async requestVerificationCode(input) { seen.push(['otp', input]); return { target: input.account, purpose: input.purpose }; },
    async register(input) { seen.push(['register', input]); return { loggedIn: true, account: input.account }; },
  };
  await dispatchAuthAction(auth, { action: 'verification-code', account: 'a@b.com', purpose: 'register', captcha_id: '1', captcha_code: '2' });
  await dispatchAuthAction(auth, { action: 'register', account: 'a@b.com', password: 'StrongPass!9', code: '123456', invite_code: 'INVITE' });
  assert.equal(seen[0][0], 'otp');
  assert.equal(seen[0][1].captchaId, '1');
  assert.equal(seen[1][1].inviteCode, 'INVITE');
  assert.throws(() => parseAuthActionBody('{'), /无效/);
});

test('guest session is memory-only, zero balance, and clears on logout', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nof-auth-guest-'));
  const auth = createWorkbenchAuth({
    home,
    fetchImpl: async () => { throw new Error('workbench must not be called for guest'); },
  });
  assert.equal((await auth.status()).loggedIn, false);
  const entered = await auth.enterGuest();
  assert.equal(entered.loggedIn, true);
  assert.equal(entered.guest, true);
  assert.equal(entered.displayName, '游客');
  assert.equal(auth.guest, true);
  const status = await auth.status();
  assert.equal(status.guest, true);
  const balance = await auth.balance();
  assert.equal(balance.available_points, 0);
  assert.equal(balance.guest, true);
  const bridged = await dispatchAuthAction(auth, { action: 'guest' });
  assert.equal(bridged.guest, true);
  assert.equal(bridged.loggedIn, true);
  const left = await auth.logout();
  assert.equal(left.loggedIn, false);
  assert.equal(auth.guest, false);
  assert.equal((await auth.status()).loggedIn, false);
});

test('enterGuest does not mask a real persisted session', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nof-auth-guest-real-'));
  const auth = createWorkbenchAuth({
    home,
    fetchImpl: async (url) => {
      if (String(url).endsWith('/api/v1/auth/login')) {
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify({
            data: { access_token: 'a1', refresh_token: 'r1', expires_at: '2099-01-01T00:00:00Z', user_id: 7 },
          }),
        };
      }
      throw new Error(String(url));
    },
  });
  await auth.login({ account: 'a@b.com', password: 'StrongPass!9', captchaId: 'c', captchaCode: 'x' });
  const again = await auth.enterGuest();
  assert.equal(again.guest, undefined);
  assert.equal(again.loggedIn, true);
  assert.equal(again.account, 'a@b.com');
  assert.equal(auth.guest, false);
});
