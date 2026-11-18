// Render the bundled shell against an isolated Studio and mock Host, never a user profile.
// This is an integration smoke test, not verification of the currently running DSH GUI.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { startStudioProxy } from '../src/studio/studio-proxy.mjs';
import { installTemplate, listTemplates } from '../src/official/official-templates.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Keep the temporary library on an ordinary path: a `%TEMP%` 8.3 alias such as
// `ADMINI~1` makes libuv's recursive Windows watcher abort in fs-event.c, which
// is an upstream/Node limitation unrelated to this integration.
const scratchBase = join(root, '.dev');
mkdirSync(scratchBase, { recursive: true });
const temp = mkdtempSync(join(scratchBase, 'workbench-check-'));
const library = join(temp, 'library');
const output = join(root, '.tmp-frames', `workbench-${Date.now()}`);
mkdirSync(library); mkdirSync(output, { recursive: true });
process.env.OPENFILM_HOME = join(temp, 'home');
process.env.OPENFILM_SHARED_HOME = join(temp, 'home');
process.env.OPENFILM_LIBRARY = library;
process.env.OPENFILM_NO_UPDATE_CHECK = '1';
process.env.NO996_OPENFILM_EDITOR_PORT = '0';
let studio, proxy, browser;
try {
  const pkg = dirname(fileURLToPath(import.meta.resolve('openfilm/package.json')));
  const { openProject } = await import(pathToFileURL(join(pkg, 'studio/server/projects.mjs')).href);
  const { startStudio } = await import('openfilm/studio');
  studio = await startStudio({ port: 0, advertise: false, stays: true, openBrowser: () => {}, editorDir: join(root, 'vendor/official-shell/ui') });
  const channels = [];
  const templateRoot = join(root, 'vendor/templates');
  proxy = await startStudioProxy({
    upstream: { origin: `http://127.0.0.1:${studio.port}`, filmOrigin: studio.filmOrigin, key: studio.key },
    authenticateBrowser: () => true, webOrigin: 'http://127.0.0.1:5999', officialShell: true,
    authorizeOfficialProject: async () => true,
    attachOfficialEvents: async ({ res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('event: ready\ndata: {}\n\n');
      // Keep the stream open: the facade treats a closed one as a broken agent.
      const beat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* closed */ } }, 5000);
      res.on('close', () => clearInterval(beat));
    },
    officialRpc: async (channel, payload) => {
      channels.push({ channel, payload });
      if (channel === 'auth:status') return { loggedIn: true };
      if (channel === 'template:list') return { templates: await listTemplates(templateRoot) };
      if (channel === 'template:create') return installTemplate({ root: templateRoot, id: payload.templateId, parentDir: library, titleFor: () => payload.templateId, createProject: async path => {
        const p = await openProject(path); return { id: p.id, path: p.path };
      } });
      if (channel === 'prefs:get') return { prefs: {} };
      if (channel === 'chat:load') return { sessions: [], turns: [] };
      return { ok: true };
    },
  });
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Record what the page actually asks the Host to send, without changing any
  // request: the draft text is assembled in the shell, so this is the real proof
  // that "参考" becomes a message reference rather than an opened project.
  const asked = [];
  await page.route('**/__dsh/official-rpc', async route => {
    try { asked.push(route.request().postDataJSON()); } catch { /* not ours */ }
    await route.continue();
  });
  await page.goto(proxy.bootstrapData().editorOrigin, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.getByRole('heading', { name: /No996 templates|No996 模板/ }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: /Start blank|空白开工/ }).waitFor();
  const card = page.locator('article').filter({ hasText: /纸纹讲堂/ });
  await card.waitFor({ timeout: 15000 });
  assert.equal(await page.locator('[data-no996-template-react]').count(), 0);
  assert.equal(await page.locator('[data-no996-onboarding]').count(), 0);
  await page.screenshot({ path: join(output, 'initial.png') });
  await card.getByRole('button', { name: /Copy and start|复制开工/ }).click();
  await page.waitForURL(/\/projects\/[A-Za-z0-9_-]{6,40}/, { timeout: 30000 });
  assert.ok(channels.some(entry => entry.channel === 'template:create'));
  const projectId = new URL(page.url()).pathname.split('/').at(-1);
  const response = await fetch(`http://127.0.0.1:${studio.port}/api/projects/${projectId}`, { headers: { 'x-studio-key': studio.key } });
  const project = await response.json();
  const canonicalLibrary = realpathSync.native(library);
  const projectPath = project.project?.path ?? project.path;
  const rel = typeof projectPath === 'string' ? relative(canonicalLibrary, realpathSync.native(projectPath)) : '..';
  if (!response.ok || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    console.log(JSON.stringify({ status: response.status, projectId, library, canonicalLibrary, projectPath, rel, body: project?.error ?? Object.keys(project ?? {}) }, null, 2));
    throw new Error('Created project was not returned under the isolated library');
  }
  assert.match(readFileSync(join(project.project?.path ?? project.path, 'film.html'), 'utf8'), /<html/i);
  // The editor must actually open the copy: the "正在打开项目" cover goes away and
  // the page is Studio's editor (not a blank frame or an error banner).
  await page.waitForFunction(() => !/正在打开项目/.test(document.body.innerText || ''), undefined, { timeout: 90000 });
  await page.waitForTimeout(5000);
  const body = await page.locator('body').innerText().catch(() => '');
  const diag = await page.locator('#no996-diag').count();
  await page.screenshot({ path: join(output, 'copied.png') });
  assert.equal(diag, 0, `the page reported an error banner:\n${body.slice(0, 400)}`);
  assert.ok(body.trim().length > 20, 'the opened project rendered no text at all');
  assert.equal(await page.locator('[data-no996-onboarding]').count(), 0);
  assert.equal(await page.locator('[data-no996-template-react]').count(), 0);

  // The once-only project entry also serves "reference": over a film, the chat's
  // "start from an example" opens this same window in example mode, and picking
  // 参考 puts one pill in the message instead of creating a project.
  await page.getByRole('button', { name: '从示例开始' }).first().click();
  const dialog = page.getByRole('dialog', { name: /项目|Projects/ });
  await dialog.waitFor({ timeout: 30000 });
  const hero = dialog.locator('[role="button"]').filter({ hasText: /./ }).first();
  await hero.hover();
  const reference = dialog.getByRole('button', { name: '参考', exact: true });
  await reference.waitFor({ timeout: 15000 });
  await reference.click();
  const sawPill = await page.waitForFunction(() => {
    const editors = [...document.querySelectorAll('[contenteditable="true"]')];
    return editors.some(node => node.querySelector('[data-lexical-decorator]') && /One Prompt|示例|example/i.test(node.textContent || ''));
  }, undefined, { timeout: 30000 }).then(() => true, () => false);
  if (!sawPill) {
    const editors = await page.evaluate(() => [...document.querySelectorAll('[contenteditable="true"]')].map(node => ({
      text: node.textContent, html: node.innerHTML.slice(0, 300),
    })));
    await page.screenshot({ path: join(output, 'reference-failed.png') });
    console.log(JSON.stringify({ editors, body: (await page.locator('body').innerText()).slice(0, 1500) }, null, 2));
    throw new Error('the picked example did not become a reference pill');
  }

  // Sending it must carry the reference block to the Host, not open the example.
  await page.locator('[contenteditable="true"]').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' 照这个做法');
  await page.keyboard.press('Enter');
  const deadline = Date.now() + 25000;
  let prompt;
  while (Date.now() < deadline && !prompt) {
    prompt = asked.find(entry => entry?.channel === 'agent:prompt' && typeof entry.payload?.text === 'string' && entry.payload.text.trim());
    if (!prompt) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!prompt) {
    await page.screenshot({ path: join(output, 'send-failed.png') });
    console.log(JSON.stringify({ asked: asked.map(entry => entry?.channel), body: (await page.locator('body').innerText()).slice(0, 800) }, null, 2));
    throw new Error('the referenced message never reached the Host');
  }
  assert.match(prompt.payload.text, /studio_references/, 'the message must carry the reference block');
  assert.match(prompt.payload.text, /One Prompt/, 'and name the example it points at');
  await page.screenshot({ path: join(output, 'reference.png') });
  const composer = await page.locator('[contenteditable="true"]').first().textContent();
  void composer;
  // A narrow window must not break the single entry either: the same window is
  // what a small laptop shows.
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.waitForTimeout(1200);
  const overflow = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') || document.body;
    return { scroll: dialog.scrollWidth, client: dialog.clientWidth, bodyScroll: document.body.scrollWidth, bodyClient: document.body.clientWidth };
  });
  assert.ok(overflow.bodyScroll <= overflow.bodyClient + 2, `the page overflows at 1120px: ${JSON.stringify(overflow)}`);
  await page.screenshot({ path: join(output, 'narrow.png') });
  console.log(JSON.stringify({ output, projectId, channels: [...new Set(channels.map(entry => entry.channel))], overflow, errors }, null, 2));
  if (errors.length) throw new Error('The browser reported uncaught errors');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (proxy) await proxy.close().catch(() => {});
  if (studio) await studio.close().catch(() => {});
  // Delete the disposable library only after Studio's watchers are closed; a
  // watched folder that vanishes is what the Windows watcher cannot survive.
  rmSync(temp, { recursive: true, force: true, maxRetries: 3 });
}
