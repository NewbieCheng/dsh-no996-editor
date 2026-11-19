import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isReleasePackage } from '../src/host/distribution.mjs';
import { createDevHmrHooks } from '../src/dev/dev-hmr-proxy.mjs';
import { createDevLiveSse } from '../src/dev/dev-live-sse.mjs';
import { startDevBrowserPortal } from '../src/dev/dev-browser-portal.mjs';
import { devFlags } from '../src/dev/index.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'f'.repeat(48);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('dev browser portal serves electron loopback APIs, redirects /editor to /, and allows embeddable cookie-free access', async (t) => {
  const studioUp = createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/projects/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>OpenFilm</title></head><body><div id="root">ok</div></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
  });
  const filmUp = createServer((_req, res) => res.writeHead(200).end(''));
  const studioPort = await listen(studioUp);
  const filmPort = await listen(filmUp);
  const studio = { origin: `http://127.0.0.1:${studioPort}`, filmOrigin: `http://localhost:${filmPort}`, key: KEY };

  const liveSse = createDevLiveSse({ root: ROOT, enabled: false });
  const portalHooks = createDevHmrHooks({ viteOrigin: null, liveSse, styleLabHtml: () => '', relaxedEmbed: true });

  let readyCalls = 0;
  const portal = await startDevBrowserPortal({
    port: 0,
    editorUrl: async () => 'http://127.0.0.2:47822/__dsh/open#abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
    authHandler: async (raw) => {
      const parsed = JSON.parse(raw);
      return { status: 200, body: { action: parsed.action, loggedIn: true } };
    },
    ensureStudioStarted: async () => { readyCalls += 1; },
    createProxyOptions: async () => ({
      officialShell: true,
      devHooks: portalHooks,
      authorizeOfficialProject: async () => true,
      officialRpc: async (channel, payload) => ({ channel, payload, ok: true }),
    }),
  });

  t.after(async () => {
    await portal.close();
    liveSse.close();
    await Promise.all([
      new Promise(done => studioUp.close(done)),
      new Promise(done => filmUp.close(done)),
    ]);
  });

  // Electron endpoints keep working at t=0.
  const studioUrlRes = await fetch(`${portal.origin}/api/studio-url`, { headers: { origin: 'dsh-app://app' } });
  assert.equal(studioUrlRes.status, 200);
  const studioUrlJson = await studioUrlRes.json();
  assert.equal(studioUrlJson.origin, 'http://127.0.0.2:47822');
  assert.equal(studioUrlJson.ticket, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ');

  const authOk = await fetch(`${portal.origin}/api/auth`, {
    method: 'POST',
    headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'status' }),
  });
  assert.equal(authOk.status, 200);
  assert.deepEqual(await authOk.json(), { action: 'status', loggedIn: true });

  const authBad = await fetch(`${portal.origin}/api/auth`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'status' }),
  });
  assert.equal(authBad.status, 403);

  // `/editor` simplifies directly to `/`.
  const editorRedirect = await fetch(`${portal.origin}/editor`, { redirect: 'manual' });
  assert.equal(editorRedirect.status, 302);
  assert.equal(editorRedirect.headers.get('location'), '/');

  // Attach upstream Studio and verify open cookie-free, embed-friendly access.
  await portal.setUpstream(studio);
  assert.equal(readyCalls, 0);

  const rootRes = await fetch(`${portal.origin}/`);
  assert.equal(rootRes.status, 200);
  assert.equal(rootRes.headers.get('content-security-policy'), null);
  const html = await rootRes.text();
  assert.match(html, /openfilmNative/);
  assert.match(html, /data-no996-theme/);
  assert.match(html, /data-no996-dev-hmr/);

  // Embedded cross-site iframe from another local Agent panel works on GET.
  const iframeRes = await fetch(`${portal.origin}/`, {
    headers: {
      origin: 'http://localhost:3000',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-dest': 'iframe',
    },
  });
  assert.equal(iframeRes.status, 200);

  // Nested iframe RPC call carries portal's own Origin while Sec-Fetch-Site may be cross-site.
  const rpcInsideIframe = await fetch(`${portal.origin}/__dsh/official-rpc`, {
    method: 'POST',
    headers: {
      origin: portal.origin,
      'sec-fetch-site': 'cross-site',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ channel: 'auth:status', payload: {} }),
  });
  assert.equal(rpcInsideIframe.status, 200);
  assert.equal((await rpcInsideIframe.json()).ok, true);

  // Cross-origin CSRF POST from an untrusted origin is still blocked.
  const csrfPost = await fetch(`${portal.origin}/__dsh/official-rpc`, {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ channel: 'auth:status', payload: {} }),
  });
  assert.equal(csrfPost.status, 403);
});

test('isReleasePackage fails closed on releaseBuild stamp or missing src/dev', () => {
  assert.equal(isReleasePackage(ROOT), false);
  const flags = devFlags({ NO996_OPENFILM_DEV: '1', NO996_OPENFILM_DEV_HMR: '1' });
  assert.equal(flags.openBrowser, true);
  assert.equal(flags.blockedByRelease, false);

  const temp = mkdtempSync(join(tmpdir(), 'dsh-no996-editor-dist-test-'));
  try {
    // Missing package.json -> treated as release (fail closed).
    assert.equal(isReleasePackage(temp), true);

    // Even if src/dev/index.mjs exists, `dsh.releaseBuild: true` forces release isolation.
    mkdirSync(join(temp, 'src', 'dev'), { recursive: true });
    writeFileSync(join(temp, 'src', 'dev', 'index.mjs'), 'export const x = 1;\n', 'utf8');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    pkg.dsh = { ...(pkg.dsh || {}), releaseBuild: true };
    writeFileSync(join(temp, 'package.json'), JSON.stringify(pkg), 'utf8');
    assert.equal(isReleasePackage(temp), true);

    // Without `releaseBuild`, missing `src/dev/index.mjs` still stays locked.
    delete pkg.dsh.releaseBuild;
    writeFileSync(join(temp, 'package.json'), JSON.stringify(pkg), 'utf8');
    assert.equal(isReleasePackage(temp), false);
    rmSync(join(temp, 'src', 'dev', 'index.mjs'));
    assert.equal(isReleasePackage(temp), true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
