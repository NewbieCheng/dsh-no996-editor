// Render the bundled shell against an isolated Studio and mock Host, never a user profile.
// This is an integration smoke test, not verification of the currently running DSH GUI.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { startStudioProxy } from '../src/studio/studio-proxy.mjs';
import { createBlankOfficialProject, installTemplate, listTemplates } from '../src/official/official-templates.mjs';
import { readFilmFile } from 'openfilm/film-doc';
import { createSpokenCreation, spokenCreationResult } from '../src/studio/spoken-creation.mjs';
import { prepareSpokenBgm } from '../src/audio/spoken-bgm.mjs';
import { extractMonoFloat32 } from '../src/audio/rhythm-analyzer.mjs';
import { BRAND_RPC_CHANNELS, createBrandRpc } from '../src/studio/brand-rpc.mjs';
import { createStudioHttp } from '../src/studio/studio-http.mjs';
import { createLocalTemplateStore } from '../src/official/local-template-store.mjs';
import { createTemplateRecipeRpc, RECIPE_RPC_CHANNELS } from '../src/studio/template-recipe-rpc.mjs';

function spokenWave() {
  const rate = 22050, length = rate * 5, wav = Buffer.alloc(44 + length * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const phase = (i / rate) % 0.5;
    if (phase < 0.057) wav.writeInt16LE(Math.round(27000 * Math.sin(i * 0.3) * Math.exp(-phase * 70)), 44 + i * 2);
  }
  return wav;
}

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
  const editorDir = resolve(root, process.env.NO996_CHECK_SHELL_DIR || 'vendor/official-shell/ui');
  studio = await startStudio({ port: 0, advertise: false, stays: true, openBrowser: () => {}, editorDir });
  const channels = [];
  let mockPrefs = { no996UpdateVersion: process.argv.includes('--update-only') ? '' : '0.22.0' };
  const chatRevisions = new Map();
  const chatRows = new Map();
  const failedHistory = new Set();
  const templateRoot = join(root, 'vendor/templates');
  const brandOnly = process.argv.includes('--brand-only');
  const recipeOnly = process.argv.includes('--recipe-only');
  let activeRecipeProject;
  let recipePrefs = { templateMarket: { url: '', refreshedAt: '', items: [] } };
  const recipeStore = createLocalTemplateStore({ root: join(temp, 'recipe-library') });
  const openedProjects = [];
  const open = async path => { const p = await openProject(path); openedProjects.push({ id: p.id, path: p.path }); return { id: p.id, path: p.path }; };
  const recipeRpc = createTemplateRecipeRpc({ store: recipeStore, verifyProject(id) {
    if (id !== activeRecipeProject?.id) throw new Error('No project');
    return activeRecipeProject;
  }, preferences: { get: async () => recipePrefs, set: async patch => (recipePrefs = { ...recipePrefs, ...patch }) },
    projectParent: () => library, createProject: open });
  let activeBrandProject;
  let brandSettings = { enabled: false, name: '', identity: '', placement: 'auto', logoBase64: null, configured: false };
  const brandRpc = createBrandRpc({ verifyProject(id) {
    if (id !== activeBrandProject?.id) throw new Error('No project');
    return activeBrandProject;
  }, http: () => createStudioHttp({ studio: () => studio }),
  memory: () => ({ full: () => brandSettings, summary: () => ({ enabled: brandSettings.enabled }),
    dismissSetup: () => { brandSettings = { ...brandSettings, configured: true }; },
    save: (value) => (brandSettings = { ...value, configured: true }) }) });
  const spokenOnly = process.argv.includes('--spoken-only');
  const spokenUpload = process.argv.includes('--upload');
  const spokenCopy = '先做一个小实验。';
  const createSpoken = createSpokenCreation({ projectParent: () => library,
    ask: async () => JSON.stringify({ beats: [{ from: 0, to: 1, role: 'action', headline: '先试一次', visual: '可编辑流程图', motion: '按步骤点亮' }] }),
    resolveBgm: args => prepareSpokenBgm({ ...args,
      resolveDefault: () => { throw new Error('mock unavailable'); },
      ...(process.env.NO996_TEST_FFMPEG ? { decode: (path, options) => extractMonoFloat32(path, { ...options, resolve: () => process.env.NO996_TEST_FFMPEG }) } : {}),
    }),
  });
  proxy = await startStudioProxy({
    upstream: studio,
    authenticateBrowser: () => false, webOrigin: 'dsh-app://app', desktop: true, officialShell: true,
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
      if (channel === 'template:create-spoken') return spokenCreationResult(createSpoken, payload, { createProject: open });
      if (BRAND_RPC_CHANNELS.includes(channel)) return brandRpc(channel, payload);
      if (RECIPE_RPC_CHANNELS.includes(channel)) return recipeRpc(channel, payload);
      if (channel === 'template:list') return { templates: await listTemplates(templateRoot) };
      if (channel === 'template:create') return installTemplate({ root: templateRoot, id: payload.templateId, ratio: payload.ratio, parentDir: library, titleFor: () => payload.templateId, createProject: async path => {
        const p = await openProject(path); return { id: p.id, path: p.path };
      } });
      if (channel === 'project:create-blank') return createBlankOfficialProject({ ratio: payload.ratio, parentDir: library, createProject: open });
      if (channel === 'client:version') return { version: '0.22.0' };
      if (channel === 'prefs:get') return { prefs: mockPrefs };
      if (channel === 'prefs:set') { mockPrefs = { ...mockPrefs, ...payload }; return { prefs: mockPrefs }; }
      if (channel === 'skills:list') return { openfilm: [], own: { agent: 'deepseek', filtered: false, skills: [] }, mine: '' };
      if (channel === 'agent:running') return { turns: [] };
      if (channel === 'chat:load') {
        if (failedHistory.has(payload.projectId)) throw Object.assign(new Error('mock history unavailable'), { code: 'OFFICIAL_CHAT_UNAVAILABLE' });
        const sessions = chatRows.get(payload.projectId) ?? [];
        return { sessions, turns: [], last: sessions[0]?.id ?? null, revision: chatRevisions.get(payload.projectId) ?? 0 };
      }
      if (channel === 'chat:save-sessions' || channel === 'chat:save-turn') {
        const revision = (chatRevisions.get(payload.projectId) ?? 0) + 1;
        chatRevisions.set(payload.projectId, revision);
        return { ok: true, revision };
      }
      return { ok: true };
    },
  });
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', '127.0.0.2', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
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
  await page.goto(proxy.issueTicket().url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (process.argv.includes('--update-only')) {
    const update = page.getByRole('dialog', { name: /0\.22\.0/ });
    await update.waitFor();
    await page.screenshot({ path: join(output, 'update-intro.png') });
    await update.getByRole('button', { name: /开始创作|Start creating/ }).click();
    await update.waitFor({ state: 'hidden' });
    assert.ok(channels.some(entry => entry.channel === 'prefs:set' && entry.payload.no996UpdateVersion === '0.22.0'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('region', { name: /No996 templates|No996 模板/ }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: /0\.22\.0/ }).count(), 0, 'the introduction is once per version');
  }
  try {
    await page.getByRole('region', { name: /No996 templates|No996 模板/ }).waitFor({ timeout: 30000 });
  } catch (error) {
    await page.screenshot({ path: join(output, 'launcher-failure.png'), timeout: 3000 }).catch(() => {});
    const screen = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    console.error('Isolated launcher failed:', { path: new URL(page.url()).pathname, screen: screen.slice(0, 700), errors: errors.slice(0, 4), channels: channels.map(entry => entry.channel).slice(0, 16) });
    throw error;
  }
  const blank = page.getByRole('group', { name: /Create blank project|新建空白项目/ });
  await blank.locator('[data-no996-create-ratio="9:16"]').waitFor();
  await blank.locator('[data-no996-create-ratio="16:9"]').waitFor();
  const templateArg = process.argv.find(arg => arg.startsWith('--template-id='));
  const templateId = templateArg?.slice('--template-id='.length) ?? 'vibe-explainer';
  const card = page.locator('article').filter({ hasText: new RegExp({ 'vibe-explainer': 'Vibe 科普剧场', 'paper-texture': '纸纹讲堂', sketchnote: '手绘笔记', 'motion-styles': '动效风格样片' }[templateId] || templateId) });
  await card.locator('[data-no996-create-ratio="9:16"]').waitFor({ timeout: 15000 });
  await card.locator('[data-no996-create-ratio="16:9"]').waitFor({ timeout: 15000 });
  assert.equal(await page.locator('[data-no996-template-react]').count(), 0);
  assert.equal(await page.locator('[data-no996-onboarding]').count(), 0);
  await page.screenshot({ path: join(output, 'initial.png') });
  const blankOnly = process.argv.includes('--blank-only');
  const selected = process.argv.includes('--portrait') || blankOnly ? '9:16' : '16:9';
  if (spokenOnly) {
    await card.getByRole('button', { name: /用口播文案创建|Create from a script/ }).click();
    const form = page.getByRole('form', { name: /用口播文案创建|Create Vibe from a script/ });
    const submit = form.getByRole('button', { name: /创建可编辑草稿|Create editable draft/ });
    await form.getByRole('textbox', { name: /口播文案|Spoken script/ }).fill(spokenCopy);
    const canvas = form.getByRole('combobox', { name: /画幅|Canvas/ });
    assert.equal(await canvas.inputValue(), '9:16');
    await canvas.selectOption(selected);
    await submit.click();
    await form.getByRole('alert').filter({ hasText: /默认配乐暂不可用|Default music is unavailable/ }).waitFor();
    assert.equal(await form.getByRole('textbox').inputValue(), spokenCopy);
    await form.getByRole('combobox', { name: /背景音乐|Background music/ }).selectOption(spokenUpload ? 'upload' : 'none');
    if (spokenUpload) await form.locator('input[type=file]').setInputFiles({ name: 'test.wav', mimeType: 'audio/wav', buffer: spokenWave() });
    await page.screenshot({ path: join(output, 'spoken-form.png') });
    await submit.click();
  } else {
    await (blankOnly ? blank : card).locator(`[data-no996-create-ratio="${selected}"]`).click();
  }
  await page.waitForURL(/\/projects\/[A-Za-z0-9_-]{6,40}/, { timeout: 30000 });
  const creation = channels.filter(entry => ['template:create', 'project:create-blank', 'template:create-spoken'].includes(entry.channel));
  if (spokenOnly) {
    assert.deepEqual(creation.map(entry => [entry.channel, entry.payload.ratio, entry.payload.music, entry.payload.copy]), [
      ['template:create-spoken', selected, 'default', spokenCopy], ['template:create-spoken', selected, spokenUpload ? 'upload' : 'none', spokenCopy],
    ]);
    if (spokenUpload) assert.deepEqual(Buffer.from(creation[1].payload.audioBase64, 'base64'), spokenWave());
  } else assert.deepEqual(creation, blankOnly ? [{ channel: 'project:create-blank', payload: { ratio: selected } }]
    : [{ channel: 'template:create', payload: { templateId, ratio: selected } }]);
  const projectId = new URL(page.url()).pathname.split('/').at(-1);
  const response = await fetch(`http://127.0.0.1:${studio.port}/api/projects/${projectId}`, { headers: { 'x-studio-key': studio.key } });
  const project = await response.json();
  const canonicalLibrary = realpathSync.native(library);
  const projectPath = project.project?.path ?? project.path;
  activeRecipeProject = { id: projectId, path: projectPath };
  activeBrandProject = activeRecipeProject;
  const rel = typeof projectPath === 'string' ? relative(canonicalLibrary, realpathSync.native(projectPath)) : '..';
  if (!response.ok || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    console.log(JSON.stringify({ status: response.status, projectId, library, canonicalLibrary, projectPath, rel, body: project?.error ?? Object.keys(project ?? {}) }, null, 2));
    throw new Error('Created project was not returned under the isolated library');
  }
  const film = readFilmFile(readFileSync(join(projectPath, 'film.html'), 'utf8'));
  assert.deepEqual(film.problems, []);
  assert.deepEqual([film.doc.stage.w, film.doc.stage.h], selected === '9:16' ? [1080, 1920] : [1920, 1080]);
  if (spokenOnly) {
    assert.equal(film.doc.tracks.length, spokenUpload ? 2 : 1);
    const draft = JSON.parse(readFileSync(join(projectPath, '.film/spoken-blueprint.json'), 'utf8'));
    assert.equal(draft.subtitles[0].text, spokenCopy);
    assert.equal(draft.music, spokenUpload ? 'upload' : 'none');
  }
  // The editor must actually open the copy: the "正在打开项目" cover goes away and
  // the page is Studio's editor (not a blank frame or an error banner).
  await page.waitForFunction(() => !/正在打开项目/.test(document.body.innerText || ''), undefined, { timeout: 90000 });
  await page.waitForTimeout(5000);
  const body = await page.locator('body').innerText().catch(() => '');
  const diag = await page.locator('#no996-diag').allTextContents();
  await page.screenshot({ path: join(output, 'copied.png') });
  assert.deepEqual(diag, [], `the page reported an error banner:\n${diag.join('\n').slice(0, 1500)}`);
  assert.ok(body.trim().length > 20, 'the opened project rendered no text at all');
  await page.locator('[data-titlebar]').waitFor({ state: 'visible' });
  if (recipeOnly) {
    await page.locator('[data-project-title-name]').click();
    await page.getByRole('button', { name: /另存为本地模板|Save as local template/ }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(output, 'recipe-dialog.png') });
    const dialog = page.getByRole('dialog', { name: /另存为本地模板|Save as local template/ });
    if (!await dialog.count()) throw new Error('Recipe dialog did not open: ' + (await page.locator('body').innerText()).slice(-1200));
    await dialog.waitFor();
    const form = dialog.locator('form');
    await form.getByRole('textbox', { name: /模板名称|Template name/ }).fill('Smoke recipe');
    const sceneBoxes = form.locator('fieldset input[type=checkbox]');
    const count = await sceneBoxes.count();
    assert.ok(count >= 1);
    for (let i = 1; i < count; i++) await sceneBoxes.nth(i).uncheck();
    await page.screenshot({ path: join(output, 'recipe-preview.png') });
    await form.getByRole('button', { name: /保存本地模板|Save local template/ }).click();
    await dialog.getByText(/本地模板已保存|Local template saved/).waitFor();
    const savedId = (await dialog.locator('code').textContent()).trim();
    assert.ok(savedId.startsWith('local-'));
    await dialog.getByRole('button', { name: /完成|Done/ }).click();
    const local = await recipeStore.list();
    assert.equal(local.length, 1);
    assert.equal(local[0].scenes, 1);
    await page.locator('[data-project-title-name]').click();
    await page.getByRole('button', { name: /全部项目|All projects/ }).click();
    await page.getByRole('button', { name: /^示例$|^Examples$/ }).click();
    const templatesRegion = page.getByRole('region', { name: /No996 templates|No996 模板/ });
    await templatesRegion.getByRole('button', { name: /本地模板与分享|Local templates & sharing/ }).waitFor({ timeout: 15000 }).catch(async () => {
      await page.screenshot({ path: join(output, 'library-missing.png') });
      throw new Error('Local library entry missing: ' + (await templatesRegion.innerText()).slice(0, 1500));
    });
    await templatesRegion.getByRole('button', { name: /本地模板与分享|Local templates & sharing/ }).click();
    const localCard = templatesRegion.locator('article').filter({ hasText: 'Smoke recipe' });
    await localCard.waitFor();
    await localCard.getByRole('button', { name: /导出分享 ZIP|Export share ZIP/ }).click();
    const downloadEvent = page.waitForEvent('download');
    await templatesRegion.getByRole('button', { name: /下载 ZIP|Download ZIP/ }).click();
    const download = await downloadEvent;
    const downloadPath = join(output, download.suggestedFilename());
    await download.saveAs(downloadPath);
    assert.ok(readFileSync(downloadPath).length > 22);
    await templatesRegion.locator('input[type=file]').setInputFiles(downloadPath);
    await localCard.waitFor();
    assert.equal((await recipeStore.list()).length, 1);
    await page.screenshot({ path: join(output, 'recipe-library.png') });
    await localCard.getByRole('button', { name: /用此配方创建|Create from recipe/ }).click();
    for (let attempt = 0; attempt < 40 && openedProjects.length < 1; attempt++) await page.waitForTimeout(250);
    if (openedProjects.length < 1) {
      await page.screenshot({ path: join(output, 'recipe-create-failed.png') });
      throw new Error('The recipe did not register a fresh project: ' + JSON.stringify(channels.filter(entry => entry.channel.startsWith('template:local'))) + ' / ' + (await page.locator('body').innerText()).slice(-900));
    }
    assert.ok(openedProjects.length >= 1, 'the recipe registered a fresh project');
    assert.notEqual(openedProjects.at(-1).id, projectId);
    const created = await recipeStore.list();
    assert.equal(created.length, 1);
  }
  if (brandOnly) {
    activeBrandProject = { id: projectId, path: projectPath };
    assert.equal(channels.some(entry => entry.channel === 'brand:settings-get'), false, 'full brand settings are lazy');
    assert.equal(await page.getByRole('button', { name: /品牌与 Logo|Brand & logo/ }).count(), 0, 'no composer entry');
    await page.locator('[data-project-title-name]').click();
    await page.getByRole('button', { name: /全部项目|All projects/ }).click();
    const hint = page.getByRole('complementary', { name: /开工提示|Getting started/ });
    await hint.waitFor();
    await page.screenshot({ path: join(output, 'brand-setup-hint.png') });
    await hint.getByRole('button', { name: /暂不设置|Skip for now/ }).click();
    await hint.waitFor({ state: 'hidden' });
    assert.equal(brandSettings.enabled, false);
    assert.equal(brandSettings.configured, true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /我的工作台|My workbench/ }).click();
    await page.getByRole('button', { name: /全局资产|Global assets/, exact: true }).click();
    const form = page.getByRole('form', { name: /品牌默认值|Brand defaults/ });
    const source = form.getByRole('combobox', { name: /Logo 来源|Logo source/ });
    const save = form.getByRole('button', { name: /^保存品牌$|^Save brand$/ });
    await form.waitFor();
    await form.getByText(/更多选项|More options/).click();
    await form.getByRole('checkbox').check();
    await source.selectOption('default');
    await save.click();
    await form.getByText(/品牌默认值已保存|Brand defaults saved/).waitFor();
    assert.deepEqual(Buffer.from(brandSettings.logoBase64, 'base64'), readFileSync(join(root, 'assets/brand/default-logo.png')));
    await form.getByRole('textbox', { name: /品牌／创作者名称|Brand or creator name/ }).fill('Demo Brand');
    await form.getByRole('textbox', { name: /写作身份|Writing identity/ }).fill('Only for private writing');
    const logo = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 3000; canvas.height = 600;
      const context = canvas.getContext('2d'); context.fillStyle = '#e86733'; context.fillRect(0, 0, 3000, 600);
      return canvas.toDataURL('image/jpeg').split(',')[1];
    }), 'base64');
    await source.selectOption('upload');
    assert.equal(await save.isEnabled(), false);
    await form.locator('input[type=file]').setInputFiles({ name: 'logo.jpg', mimeType: 'image/jpeg', buffer: logo });
    const preview = form.locator('[data-brand-preview]');
    await preview.getByRole('img').waitFor();
    await form.getByRole('button', { name: /竖屏|Portrait/, exact: true }).click();
    assert.equal(await preview.getAttribute('data-brand-preview'), '9:16');
    assert.equal(await preview.locator('[data-brand-corner]').getAttribute('data-brand-corner'), 'top-left');
    await form.getByRole('button', { name: /浅底|Light/, exact: true }).click();
    assert.match(await preview.getAttribute('style'), /rgb\(231, 232, 235\)|#e7e8eb/);
    const portraitWidth = await preview.evaluate(node => node.getBoundingClientRect().width);
    const nameSize = await preview.locator('[data-brand-corner] span').evaluate(node => parseFloat(getComputedStyle(node).fontSize) * 8);
    assert.ok(nameSize < portraitWidth, 'the name is not taller than the frame it sits in');
    await form.getByRole('button', { name: /单 Logo|Logo only/, exact: true }).click();
    assert.equal(await preview.getByText('Demo Brand').count(), 0);
    await form.getByRole('button', { name: /Logo＋名称|Logo \+ name/, exact: true }).click();
    await preview.getByText('Demo Brand').waitFor();
    await page.screenshot({ path: join(output, 'brand-live-preview.png') });
    await save.click();
    await page.getByRole('button', { name: /管理本片品牌|Manage this film/ }).click();
    const panel = page.getByRole('region', { name: /本片品牌|Project brand/ });
    await panel.getByRole('button', { name: /用于本片|Use for this film/ }).click();
    await panel.getByRole('combobox', { name: /本片 Logo 位置|Project logo position/ }).selectOption('top-right');
    const savedPath = join(projectPath, '.film/brand.json');
    for (let attempt = 0; attempt < 15; attempt++) {
      if (JSON.parse(readFileSync(savedPath, 'utf8')).placement === 'top-right') break;
      await page.waitForTimeout(50);
    }
    const snapshot = JSON.parse(readFileSync(savedPath, 'utf8'));
    assert.equal(snapshot.placement, 'top-right');
    assert.equal(snapshot.name, 'Demo Brand');
    assert.equal(snapshot.display, 'logo-name');
    assert.equal(snapshot.logo.width, 1600);
    assert.equal(snapshot.logo.height, 320);
    assert.deepEqual(readFileSync(join(projectPath, snapshot.logo.path)), Buffer.from(brandSettings.logoBase64, 'base64'));
    const timelineLogo = () => readFilmFile(readFileSync(join(projectPath, 'film.html'), 'utf8')).doc.tracks[0].clips.find(clip => clip.id === 'no996-project-logo');
    await panel.getByRole('button', { name: /把 Logo 放入影片|Place logo on timeline/ }).click();
    await panel.getByText(/Logo 已放入时间轴|Logo is on the timeline/).waitFor({ timeout: 15000 });
    const placed = timelineLogo();
    assert.match(placed.src, /\/lockup-[a-f0-9]{64}\.html$/);
    const placementPage = readFileSync(join(projectPath, placed.src), 'utf8');
    assert.match(placementPage, /data-element-id="brand-name">Demo Brand/);
    assert.match(placementPage, /data-element-id="brand-mark"/);
    assert.ok(placed.box.x > film.doc.stage.w / 2 && placed.box.y < film.doc.stage.h / 2);
    assert.equal(placed.time[1], 2.2);
    await panel.getByRole('combobox', { name: /本片 Logo 位置|Project logo position/ }).selectOption('bottom-left');
    await panel.getByText(/本片品牌设置已保存|Project brand settings saved/).waitFor();
    await panel.getByRole('button', { name: /更新影片中的 Logo|Update logo on timeline/ }).click();
    await panel.getByText(/Logo 已放入时间轴|Logo is on the timeline/).waitFor();
    const moved = timelineLogo();
    assert.deepEqual(moved.time, placed.time);
    assert.ok(moved.box.x < film.doc.stage.w / 2 && moved.box.y > film.doc.stage.h / 2);
    await page.screenshot({ path: join(output, 'brand-panel.png') });
    await panel.getByRole('button', { name: /从影片移除 Logo|Remove logo from timeline/ }).click();
    await panel.getByText(/已从时间轴移除 Logo|Logo removed from the timeline/).waitFor();
    assert.equal(timelineLogo(), undefined);
    await panel.getByRole('button', { name: /停用本片品牌记忆|Disable brand memory for this film/ }).click();
    await panel.getByText(/未给这部影片应用品牌|No brand applied/).waitFor();
    assert.equal(JSON.parse(readFileSync(savedPath, 'utf8')).mode, 'off');
    assert.equal(brandSettings.enabled, true);
  }
  // Real browser import with the editor Origin, not merely a successful HTTP response.
  const loaded = await page.evaluate(async () => {
    const response = await fetch('/api/plugins');
    const { plugins } = await response.json();
    const result = [];
    for (const plugin of plugins.filter(item => item.element)) {
      const { default: element } = await import(plugin.element);
      if (!(element?.prototype instanceof HTMLElement)) throw new Error(`Invalid module: ${plugin.id}`);
      result.push(plugin.id);
    }
    return result;
  });
  for (const id of ['edit', 'screening', 'canvas']) assert.ok(loaded.includes(id), `workbench module missing: ${id}`);
  const mode = page.locator('[data-work-mode]');
  const initialMode = await mode.getAttribute('data-work-mode');
  const modes = ['edit', 'screening', 'canvas', 'edit'];
  const waitForWorkbench = id => page.waitForFunction(async modeId => {
    const { plugins } = await (await fetch('/api/plugins')).json();
    const url = plugins.find(item => item.id === modeId)?.element;
    if (!url) return false;
    const { default: workbench } = await import(url);
    return [...document.querySelectorAll('*')].some(node => node instanceof workbench && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
  }, id, { polling: 400, timeout: 15000 });
  for (let previous = initialMode, i = 0; !process.argv.includes('--creation-only') && !recipeOnly && i < modes.length; i++) {
    const id = modes[i];
    if (previous !== id) {
      await mode.click();
      await page.locator(`[data-mode-option="${id}"]`).click();
      await page.locator(`[data-work-mode="${id}"]`).waitFor();
      const guide = page.locator('[role="dialog"]').getByRole('button', { name: /关闭|Close/ });
      if (await guide.count() && await guide.first().isVisible()) await guide.first().click();
      previous = id;
    }
    await waitForWorkbench(id);
    assert.equal(new URL(page.url()).pathname.split('/').at(-1), projectId);
    await page.screenshot({ path: join(output, `mode-${id}.png`) });
  }
  await page.locator('[data-no996-account="topbar"]').waitFor();
  assert.deepEqual(errors, [], 'opening and switching workbenches must not throw a page error');
  assert.doesNotMatch(body, /starter\.examples/, 'the chat must display the translated example label');
  assert.equal(await page.locator('[data-no996-onboarding]').count(), 0);
  assert.equal(await page.locator('[data-no996-template-react]').count(), 0);

  if (process.argv.includes('--navigation-only')) {
    const createdAt = new Date().toISOString();
    chatRows.set(projectId, [
      { id: 'last-chat', title: 'Never select this one', createdAt, updatedAt: createdAt, turns: 0 },
      { id: 'exact-chat', title: 'Exact target', createdAt, updatedAt: createdAt, turns: 0 },
    ]);
    failedHistory.add(projectId);
    await page.evaluate(project => {
      // This is the state the authenticated parent handoff records once it
      // changes the frame route. Reload while history is still unavailable.
      history.replaceState({ ...history.state, __no996EditingTarget: { projectId: project, sessionId: 'exact-chat', requestId: 1 } }, '');
    }, projectId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-no996-editing-request="unavailable"]').waitFor();
    assert.equal(await page.locator('[contenteditable="true"]').count(), 0, 'no composer for an unresolved explicit target');
    failedHistory.delete(projectId);
    const exactAttach = page.waitForRequest(request => {
      if (!request.url().endsWith('/__dsh/official-rpc') || request.method() !== 'POST') return false;
      const body = request.postDataJSON();
      return body?.channel === 'agent:attach' && body.payload?.projectId === projectId && body.payload?.conversation === 'exact-chat';
    });
    await page.getByRole('button', { name: /重试读取历史|Retry reading history/ }).click();
    await page.locator('[data-no996-editing-request]').waitFor({ state: 'hidden' });
    await exactAttach;
    await page.waitForFunction(() => !window.__no996PendingSession);
    assert.ok(channels.some(e => e.channel === 'chat:load' && e.payload.projectId === projectId));
    assert.ok(!channels.some(e => e.channel === 'agent:prompt'), 'recovering history must not send a prompt');
  } else if (!process.argv.includes('--creation-only') && !process.argv.includes('--update-only') && !blankOnly && !spokenOnly && !brandOnly && !recipeOnly) {
  // The once-only project entry also serves "reference": over a film, the chat's
  // "start from an example" opens this same window in example mode, and picking
  // 参考 puts one pill in the message instead of creating a project.
  await page.getByRole('button', { name: '从示例开始' }).first().click();
  const dialog = page.getByRole('dialog', { name: /资源中心|Resource [Cc]enter/ });
  await dialog.waitFor({ timeout: 30000 });
  // The resource window opens on No996 templates; the examples, and the "参考" they offer, are one tab over.
  await dialog.getByRole('tab', { name: /^示例$|^Examples$/ }).click();
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
  }
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
