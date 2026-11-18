#!/usr/bin/env node
/**
 * End-to-end headless Chrome verification for:
 *   1. Real-time Vite React Fast Refresh HMR (TSX edit updates DOM while keeping React state & zero navigation)
 *   2. Real-time theme CSS hot-swap (CSS edit updates computed style with zero reload)
 *   3. Pinpointed 503 error capture -> bottom banner -> In-App Diagnostic Log Center
 *
 * Uses isolated Studio + Vite Dev Server + repo-local `.dev/` scratch (never `%TEMP%`).
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createDiagnosticLog } from '../src/host/diagnostic-log.mjs';
import { createDshNativeAgentService } from '../src/native/dsh-native-agent-service.mjs';
import { createOfficialChatRpc } from '../src/official/official-chat-rpc.mjs';
import { createDiagLogsController } from '../src/studio/studio-controller/routes/diag-logs.mjs';
import { startDevBrowserPortal } from '../src/dev/dev-browser-portal.mjs';
import { createDevHmrHooks } from '../src/dev/dev-hmr-proxy.mjs';
import { createDevLiveSse } from '../src/dev/dev-live-sse.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKOUT = join(ROOT, '.upstream', 'openfilm');
const SCRATCH_BASE = join(ROOT, '.dev');
mkdirSync(SCRATCH_BASE, { recursive: true });
const temp = mkdtempSync(join(SCRATCH_BASE, 'hmr-check-'));
const diagDir = join(temp, 'logs');
const library = join(temp, 'library');
mkdirSync(library, { recursive: true });

process.env.OPENFILM_HOME = join(temp, 'home');
process.env.OPENFILM_SHARED_HOME = join(temp, 'home');
process.env.OPENFILM_LIBRARY = library;
process.env.OPENFILM_NO_UPDATE_CHECK = '1';
process.env.NO996_OPENFILM_EDITOR_PORT = '0';

const drawerFile = join(CHECKOUT, 'packages', 'openfilm', 'studio', 'ui', 'src', 'components', 'DiagnosticLogsDrawer.tsx');
const themeCssFile = join(ROOT, 'assets', 'theme', 'shell.css');
const origDrawer = readFileSync(drawerFile, 'utf8');
const origThemeCss = readFileSync(themeCssFile, 'utf8');

let studio, viteServer, liveSse, portal, agentHostServer, browser, diagLog;
try {
  const { startStudio } = await import('openfilm/studio');
  studio = await startStudio({
    port: 0,
    advertise: false,
    stays: true,
    openBrowser: () => {},
    editorDir: join(ROOT, 'vendor', 'official-shell', 'ui'),
  });

  const viteEntry = join(CHECKOUT, 'apps', 'desktop', 'node_modules', 'vite', 'dist', 'node', 'index.js');
  const { createServer } = await import(pathToFileURL(viteEntry).href);
  viteServer = await createServer({
    configFile: join(CHECKOUT, 'apps', 'desktop', 'shell', 'vite.config.ts'),
    server: {
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      hmr: { path: '/__dsh_vite_hmr' },
      fs: { allow: [CHECKOUT] },
    },
  });
  await viteServer.listen();
  const viteAddr = viteServer.httpServer.address();
  const viteOrigin = `http://127.0.0.1:${viteAddr.port}`;

  diagLog = createDiagnosticLog({ dir: diagDir });
  const ctx = {
    sessionController: {
      modelCatalog: async () => ({
        default: { provider: 'deepseek', model: 'deepseek-chat' },
        groups: [{
          id: 'deepseek',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek', reasoning: { efforts: ['off', 'low', 'medium'], defaultEffort: 'medium' } }],
        }],
      }),
      selectModel: async () => {},
      projections: async () => null,
      create: async () => ({ sessionId: 'sess-hmr' }),
      prompt: async () => {},
      cancel: async () => {},
      follow: async function* () {},
    },
    on: () => () => {},
    get: () => null,
  };
  const agent = createDshNativeAgentService({
    ctx,
    verifier: async (projectId) => ({ projectId, path: temp }),
    store: { get: () => undefined, set: () => {}, getSession: () => undefined, setSession: () => {} },
    emit: () => true,
    diag: diagLog,
  });
  const chatRpc = createOfficialChatRpc(
    { load: async () => ({ sessions: [], last: null, turns: [], revision: 0 }), saveSessions: async () => 1, saveTurn: async () => 1 },
    agent,
  );
  const diagLogs = createDiagLogsController({
    ctx,
    diagLog,
    pluginLog: { tail: () => [] },
    preferences: { set: async (p) => p },
    runtime: { health: async () => ({ running: true, port: studio.port }) },
    agentService: agent,
    pluginVersion: '0.15.33',
    openfilmVersion: '0.3.2',
    officialShell: true,
  });

  liveSse = createDevLiveSse({ root: ROOT, enabled: true });
  const portalHooks = createDevHmrHooks({ viteOrigin, liveSse, styleLabHtml: () => '', relaxedEmbed: true });
  const upstreamSpec = { origin: `http://127.0.0.1:${studio.port}`, filmOrigin: studio.filmOrigin, key: studio.key };

  portal = await startDevBrowserPortal({
    port: 0,
    ensureStudioStarted: async () => {},
    createProxyOptions: async () => ({
      officialShell: true,
      authorizeOfficialProject: async () => true,
      attachOfficialEvents: async ({ res }) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write('event: ready\ndata: {}\n\n');
      },
      officialRpc: async (channel, payload, meta) => {
        if (channel === 'auth:status') return { loggedIn: true, dev: true, account: 'dev@local', displayName: '开发模式' };
        if (channel === 'prefs:get') return { prefs: { onboardingCompleted: true } };
        if (channel === 'template:list') return { templates: [], prefs: {} };
        if (channel.startsWith('diag:')) return diagLogs.handleRpc(channel, payload);
        return chatRpc(channel, payload, meta);
      },
      diagLog,
      devHooks: portalHooks,
    }),
  });
  await portal.setUpstream(upstreamSpec);

  const editorOrigin = portal.origin;
  agentHostServer = createHttpServer((_req, res) => {
    const html = `<!doctype html><meta charset="utf-8"><body><iframe id="agent-frame" src="${editorOrigin}/" style="width:100%;height:700px;border:0"></iframe></body>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) }).end(html);
  });
  await new Promise((resolve, reject) => {
    agentHostServer.once('error', reject);
    agentHostServer.listen(0, 'localhost', resolve);
  });
  const agentHostUrl = `http://localhost:${agentHostServer.address().port}/`;

  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${editorOrigin}/editor`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  assert.equal(new URL(page.url()).pathname, '/');
  await page.locator('#no996-dev-hmr-badge').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => Boolean(document.getElementById('root')?.firstElementChild), undefined, { timeout: 30000 });
  await page.evaluate(() => { window.__hmrSentinel = 'alive'; });

  // 1. Trigger a pinpointed 503 error (like screenshot's agent:select-thinking) and open Diagnostic Log Center from red banner
  await page.evaluate(async () => {
    await fetch('/__dsh/official-rpc', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'agent:select-thinking', payload: { projectId: 'proj1234', value: 'max' } }),
    });
  });

  const diagBanner = page.locator('#no996-diag');
  await diagBanner.waitFor({ timeout: 10000 });
  await diagBanner.locator('button', { hasText: '查看诊断日志' }).click();

  const drawerTitle = page.locator('#no996-diag-center-title');
  await drawerTitle.waitFor({ timeout: 10000 });
  try {
    await page.waitForFunction(() => (document.body.innerText || '').includes('OFFICIAL_AGENT_INPUT'), undefined, { timeout: 10000 });
    await page.waitForFunction(() => (document.body.innerText || '').includes('dsh-native-agent-service.mjs:selectThinking'), undefined, { timeout: 10000 });
  } catch (err) {
    const snap = await page.evaluate(() => ({
      banner: document.querySelector('#no996-diag')?.innerText || '',
      bannerTrace: document.querySelector('#no996-diag')?.getAttribute('data-last-trace') || '',
      drawer: document.querySelector('[aria-labelledby="no996-diag-center-title"]')?.innerText || '',
      buf: (window.__no996DiagBuffer || []).map(x => ({ code: x.code, traceId: x.traceId, channel: x.channel })),
    }));
    const listed = await diagLog.list({ limit: 20 });
    console.error('DIAG SNAPSHOT:', JSON.stringify({ snap, hostItems: listed.items }, null, 2));
    throw err;
  }

  // 2. Live theme CSS hot-swap (no reload, drawer stays open)
  writeFileSync(themeCssFile, `${origThemeCss}\nbody { --no996-hmr-css-probe: rgb(12, 34, 56); }\n`, 'utf8');
  await page.waitForFunction(
    () => getComputedStyle(document.body).getPropertyValue('--no996-hmr-css-probe').trim() === 'rgb(12, 34, 56)',
    undefined,
    { timeout: 10000 },
  );

  // 3. Real React Fast Refresh TSX HMR (drawer stays open, title updates without navigation)
  assert.ok(origDrawer.includes('错误与诊断日志中心'), 'expected title marker in DiagnosticLogsDrawer.tsx');
  writeFileSync(drawerFile, origDrawer.replace('错误与诊断日志中心', '错误与诊断日志中心 [HMR-OK]'), 'utf8');
  await page.waitForFunction(
    () => document.querySelector('#no996-diag-center-title')?.textContent?.includes('[HMR-OK]'),
    undefined,
    { timeout: 15000 },
  );

  const state = await page.evaluate(() => ({
    sentinel: window.__hmrSentinel,
    navCount: performance.getEntriesByType('navigation').length,
    drawerStillOpen: Boolean(document.querySelector('#no996-diag-center-title')),
  }));
  assert.equal(state.sentinel, 'alive');
  assert.equal(state.navCount, 1);
  assert.equal(state.drawerStillOpen, true);

  // 4. Verify external Agent cross-origin iframe embedding works seamlessly
  const embedPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await embedPage.goto(agentHostUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const iframe = embedPage.frameLocator('#agent-frame');
  await iframe.locator('#no996-dev-hmr-badge').waitFor({ timeout: 20000 });
  await iframe.locator('#root > *').first().waitFor({ timeout: 30000 });
  const rpcInFrame = await iframe.locator('body').evaluate(async () => {
    const r = await fetch('/__dsh/official-rpc', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'auth:status', payload: {} }),
    });
    return { status: r.status, json: await r.json() };
  });
  assert.equal(rpcInFrame.status, 200);
  assert.equal(rpcInFrame.json.loggedIn, true);
  await embedPage.close();

  console.log('dev-hmr-check OK: Open Portal + iframe embed + React Fast Refresh HMR + CSS hot-swap + 503 pinpoint diag drawer verified.');
} finally {
  writeFileSync(drawerFile, origDrawer, 'utf8');
  writeFileSync(themeCssFile, origThemeCss, 'utf8');
  await browser?.close().catch(() => {});
  if (agentHostServer) await new Promise(done => agentHostServer.close(done));
  await portal?.close().catch(() => {});
  liveSse?.close();
  diagLog?.close();
  await viteServer?.close().catch(() => {});
  await studio?.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
