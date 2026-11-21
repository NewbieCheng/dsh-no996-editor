import { filmSkillCatalog, skillListing } from '../native/film-skill-selection.mjs';
import { createElevationProbe } from '../host/elevation.mjs';
import { createStudioRuntime } from './studio-runtime.mjs';
import { studioSystemCode } from './studio-proxy/upstream.mjs';
import { createHostComponentDetector } from '../host/host-components.mjs';
import { blankFilmHtml, finishTemplateCreation, installTemplate, listTemplates } from '../official/official-templates.mjs';
import {
  balanceCachePatch,
  balanceFromPrefs,
  clearBalanceCachePatch,
  createPreferencesStore,
  onboardingCopy,
  productMeta,
} from '../host/preferences.mjs';
import { createToolInstaller } from '../tools/tool-installer.mjs';
import { augmentPath } from '../host/download-sources.mjs';
import { applyStudioLibraryPatch } from './studio-library-patch.mjs';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// The running Host's own build identity. A plugin reload that re-imports this
// module rewrites the marker; a stale marker proves the process kept old code.
// Read fresh on every evaluation: require() caches JSON, which made this
// report the version from the first load after a hot reload.
const HOST_VERSION = (() => { try { return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version); } catch { return 'unknown'; } })();

const templatesRoot = fileURLToPath(new URL('../../vendor/templates/', import.meta.url));
const externalTemplateRoot = () => join(homedir(), '.openfilm', 'Templates');

/** The ACP path is the default; an explicit 0 is the escape hatch. */
/** Page events the Host will record; anything else is refused. */
const CLIENT_EVENTS = new Set(['recovery-shown', 'restart-click', 'picker-placed', 'session-expired', 'permission-shown', 'permission-chosen', 'switch-lost', 'switch-remounted', 'agent-attach-failed']);
import { startDesktopLoopback } from './desktop-loopback.mjs';
import { createDiagnosticLog } from '../host/diagnostic-log.mjs';
import { isReleasePackage } from '../host/distribution.mjs';
import { createDshAskAgent } from '../host/dsh-ai.mjs';
import { reportPresetStatus } from '../host/preset-report.mjs';
import { createGuideTool } from '../tools/guide-tool.mjs';
import { createStoryboardTool } from '../tools/storyboard-tool.mjs';
import { templateCatalog, templateDetails } from '../film/template-catalog.mjs';

import { readActiveTemplates, writeActiveTemplates } from '../film/template-prompts.mjs';
import { PERSONA } from '../native/openfilm-persona.mjs';
import { instructionChain } from '../native/instruction-inventory.mjs';
import { createStudioHttp } from './studio-http.mjs';
import { createFrameTool } from '../tools/frame-tool.mjs';
import { createFilmTool } from '../tools/film-tool.mjs';
import { createFontsTool } from '../tools/fonts-tool.mjs';
import { createLibraryTool } from '../tools/library-tool.mjs';
import { createVisionTools } from '../tools/vision-tool.mjs';
import { createGetTool } from '../tools/get-tool.mjs';

import { createClipTool } from '../tools/clip-tool.mjs';
import { createAssetsTool } from '../tools/assets-tool.mjs';
import { createAudioTool } from '../tools/audio-tool.mjs';
import { createExportTool } from '../tools/export-tool.mjs';
import { createCliTool } from '../tools/cli-tool.mjs';
import { createTranscribeTool } from '../tools/transcribe-tool.mjs';
import { createKitTool } from '../tools/kit-tool.mjs';
import { createRhythmTool } from '../tools/rhythm-tool.mjs';
import { createSfxTool } from '../tools/sfx-tool.mjs';
import { createModeTool } from '../tools/mode-tool.mjs';
import { createTranscribeService } from '../asr/transcribe-service.mjs';
import { refineTranscript } from '../asr/asr-refine.mjs';
import { resolveOfficialShell } from '../official/official-shell.mjs';
import { openOfficialChatStore } from '../official/official-chat-store.mjs';
import { createOfficialChatRpc } from '../official/official-chat-rpc.mjs';
import { createOfficialEventHub } from '../official/official-event-hub.mjs';
import { createOfficialApprovals } from '../official/official-approvals.mjs';
import { createDshNativeAgentService } from '../native/dsh-native-agent-service.mjs';
import { createDshSessionStore } from '../native/dsh-session-store.mjs';
import { createEditingPrefs } from '../project/editing-prefs.mjs';
import { createProjectTrash } from '../project/project-trash.mjs';
import { createEditingProjectDelete } from '../project/editing-project-delete.mjs';
import { buildEditingProjects } from '../project/editing-sessions.mjs';
import { ensureProjectInstructions, upgradeProjectInstructions } from '../project/project-instructions.mjs';
import { attachOfficialEventStream } from '../official/official-event-stream.mjs';
import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { registerTemplateBridge } from '../film/template-bridge.mjs';
import { registerArchiveBridge } from '../project/archive-bridge.mjs';
import { registerAuthBridge, dispatchAuthAction } from '../auth/auth-bridge.mjs';
import { createWorkbenchAuth, parseAuthActionBody } from '../auth/workbench-auth.mjs';
import { createLoginRememberStore } from '../auth/login-remember.mjs';
import { installVoiceBridgeGlobal } from '../voice/voice-bridge.mjs';
import { createNo996StudioBridge } from '../media/no996-studio-bridge.mjs';
import { createNo996VoiceSettings } from '../voice/no996-voice-settings.mjs';
import { installNo996Provider, preferNo996Defaults } from '../voice/install-no996-provider.mjs';
import { createArchiveWatcher } from '../project/workspace-archive.mjs';
import { createPluginLog } from '../host/plugin-log.mjs';
import { createBridgeTrace } from '../host/bridge-trace.mjs';
import { createChatTrace } from '../host/chat-trace.mjs';
import { openProjectPermissions, FULL_ACCESS, WORKSPACE_WRITE } from '../official/official-permission.mjs';
import { createProjectFiles } from '../project/project-files.mjs';
import { readJsonBody } from './studio-controller/http-body.mjs';
import { createRouter } from './studio-controller/router.mjs';
import { createAssetRoutes } from './studio-controller/routes/assets.mjs';
import { createBootstrapRoute } from './studio-controller/routes/bootstrap.mjs';
import { createDiagnoseRoute } from './studio-controller/routes/diagnose.mjs';
import { createDiagLogsController } from './studio-controller/routes/diag-logs.mjs';
import { createEnvironmentRoute } from './studio-controller/routes/environment.mjs';
import { createDiagnosticsRoutes } from './studio-controller/routes/diagnostics.mjs';
import { createEditingRoutes } from './studio-controller/routes/editing.mjs';
import { createEditingArchiveBatch } from '../project/editing-archive-batch.mjs';
import { createSystemRoutes } from './studio-controller/routes/system.mjs';
import { createTurnLog } from './studio-controller/turns.mjs';
import { buildFallbackPayload } from '../host/fallback-prompt.mjs';

/**
 * Host-only route and Studio lifecycle. `createProxy` receives the private
 * upstream instance; only its key-free editor origin may reach the browser.
 * The proxy must enforce its own cookie, Host, Origin and WebSocket checks.
 * This is a localhost integration, not an OS or network sandbox.
 */
const isElevated = createElevationProbe();

export function createStudioController(ctx, createProxy, {
  officialShell = false,
  workbenchAuth: providedAuth = null,
  onAuthChanged = undefined,
  registerWalletDirtyListener = undefined,
} = {}) {
  const log = createPluginLog();
  const diagLog = createDiagnosticLog();
  // What the bridge actually published to the panel, and what the page reported
  // receiving. Read through /diagnose; never exposed as user content.
  const bridgeTrace = createBridgeTrace();
  const openedAt = Date.now();
  if (!ctx?.connection || !ctx?.webServer || typeof createProxy !== 'function') throw new TypeError('Connection, webServer and proxy are required');
  if (typeof officialShell !== 'boolean') throw new TypeError('officialShell must be a boolean');
  const webOrigin = ctx.webServer.getOrigin();
  const origin = new URL(webOrigin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || ctx.connection.allowsRemoteAuthorities) {
    throw new Error('OpenFilm integration requires a local HTTP DSH origin');
  }
  let upstream;
  let disposed = false;
  let lastHealthRunning;
  // The one live view of DSH's durable archive set. Optional: a profile without
  // the Workspace registry reports `available: false` instead of guessing.
  const archive = createArchiveWatcher(ctx);
  const workbenchAuth = providedAuth || createWorkbenchAuth({ dev: process.env.NO996_OPENFILM_DEV === '1' });
  let walletDirtyAt = 0;
  const markWalletDirty = () => { walletDirtyAt = Date.now(); };
  registerWalletDirtyListener?.(markWalletDirty);
  const voiceBridge = createNo996StudioBridge({ auth: workbenchAuth, onWalletDirty: markWalletDirty });
  const disposeVoiceBridge = installVoiceBridgeGlobal(voiceBridge);
  const voiceSettings = createNo996VoiceSettings({ auth: workbenchAuth, bridge: voiceBridge });
  const refreshVoiceChoice = () => {
    voiceSettings.invalidate();
    return voiceSettings.prepare().then(
      choice => { log.info('no996-voice-ready', { status: choice.status, automatic: choice.automatic }); },
      error => { log.warn('no996-voice-ready', { message: String(error?.message || error).slice(0, 200) }); },
    );
  };
  void refreshVoiceChoice();
  const installVoiceProvider = installNo996Provider().then(async (info) => {
    if (info.written) log.info('no996-provider-installed', { file: info.providerFile });
    // Official added.mjs drops providers with empty id/name/env — catch that here.
    try {
      const mod = await import(`${pathToFileURL(info.providerFile).href}?boot=${Date.now()}`);
      const p = mod?.default;
      for (const field of ['id', 'name', 'env']) {
        if (typeof p?.[field] !== 'string' || !p[field]) {
          throw new Error(`added-provider field "${field}" is empty (OpenFilm will ignore no996)`);
        }
      }
    } catch (error) {
      log.warn('no996-provider-invalid', { message: String(error?.message || error).slice(0, 200) });
    }
    return preferNo996Defaults({ force: false, verbs: ['image', 'web-search'] });
  }).then((pref) => {
    if (pref?.changed) log.info('no996-media-preferred', pref);
  }).catch((error) => {
    log.warn('no996-provider-install', { message: String(error?.message || error).slice(0, 200) });
  });
  void installVoiceProvider.then(refreshVoiceChoice, () => {});
  const loginRemember = createLoginRememberStore();
  let permissionsPromise;
  let httpClient;
  let officialStorePromise;
  let lastProxy;
  let debugBridge;
  // The installer's resolved path wins over PATH so a downloaded or packaged
  // binary is what actually gets probed and, later, invoked.
  // A GUI launched from Finder or the Start menu does not inherit the shell's
  // PATH; without this a brew/WinGet ffmpeg is "already installed but missing".
  augmentPath();
  // The local-services list is native Studio data, but it lives inside the
  // installed openfilm package; re-apply our two data edits on every start so a
  // reinstall cannot silently drop SenseVoice.
  const studioPackageRoot = (() => {
    try { return fileURLToPath(new URL('.', import.meta.resolve('openfilm/package.json'))); } catch { return null; }
  })();
  const libraryPatch = applyStudioLibraryPatch({ packageRoot: studioPackageRoot, logger: log });
  if (libraryPatch.patched) log.info('studio-library-patch', libraryPatch);
  const toolInstaller = createToolInstaller({ home: process.env.DSH_HOME || join(homedir(), '.dsh') });
  const detectHostComponents = createHostComponentDetector({ resolve: name => toolInstaller.resolveAny(name)?.path ?? null });
  let componentCheck;
  // Write the preset activation result once per Host start so it can be checked
  // without a browser session (see preset-report.mjs).
  const presetReport = reportPresetStatus(ctx);
  // Prove which Host build is actually running, without a browser session.
  // Written on every controller construction, so a plugin reload overwrites it.
  void writeFile(join(tmpdir(), 'no996-editor-host.json'), JSON.stringify({
    version: HOST_VERSION,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    injected: true,
  }, null, 1), 'utf8').catch(() => { /* diagnostics only */ });
  presetReport.done.catch(() => {});
  // Production desktop loopback serves ONLY /api/studio-url and /api/auth for
  // `dsh-app://app`. Standalone browser portal (`src/dev/dev-browser-portal.mjs`)
  // is physically omitted from release `.tgz` builds and refused whenever
  // `isReleasePackage()` is true, even if dev env vars are set.
  const releaseBuild = isReleasePackage();
  const devEnvRequested = process.env.NO996_OPENFILM_DEV === '1'
    || process.env.NO996_OPENFILM_DEV_HMR === '1'
    || process.env.NO996_OPENFILM_DEBUG_EDITOR === '1'
    || process.env.NO996_OPENFILM_OPEN_BROWSER === '1'
    || process.env.NO996_OPENFILM_STYLE_LAB === '1';
  if (releaseBuild && devEnvRequested) {
    log.warn('dev-flags-ignored-in-release-package');
  }
  const devOpenBrowser = !releaseBuild
    && process.env.NO996_OPENFILM_OPEN_BROWSER !== '0'
    && (process.env.NO996_OPENFILM_DEV === '1'
      || process.env.NO996_OPENFILM_DEV_HMR === '1'
      || process.env.NO996_OPENFILM_DEBUG_EDITOR === '1'
      || process.env.NO996_OPENFILM_OPEN_BROWSER === '1');
  let browserPortal = null;
  let portalProxyOptions = async () => null;
  let ensureStudioForPortal = async () => {};
  if (process.env.NO996_OPENFILM_DEBUG_PORT !== '0') {
    const loopbackConfig = {
      editorUrl: async () => {
        if (disposed) return null;
        try {
          await runtime.ensureStarted();
          if (disposed || !upstream) return null;
          const proxy = await proxyFor(webOrigin);
          return proxy?.issueTicket?.()?.url ?? null;
        } catch { return null; }
      },
      authHandler: async raw => {
        if (disposed) return { status: 503, body: { error: 'UNAVAILABLE' } };
        try {
          const value = parseAuthActionBody(raw);
          const result = await dispatchAuthAction(workbenchAuth, value);
          void refreshVoiceChoice();
          onAuthChanged?.();
          return { status: 200, body: result };
        } catch (error) {
          const status = Number(error?.status) || 400;
          return {
            status: status >= 100 && status <= 599 ? status : 400,
            body: {
              error: String(error?.code || 'AUTH'),
              message: String(error?.message || '请求失败').slice(0, 200),
            },
          };
        }
      },
    };
    debugBridge = devOpenBrowser
      ? import('../dev/dev-browser-portal.mjs')
        .then(mod => mod.startDevBrowserPortal({
          ...loopbackConfig,
          ensureStudioStarted: () => ensureStudioForPortal(),
          createProxyOptions: () => portalProxyOptions(),
          say: log,
        }))
        .then((portal) => {
          browserPortal = portal;
          if (!disposed && upstream) void portal.setUpstream(upstream).catch(() => {});
          return portal;
        })
        .catch(() => startDesktopLoopback(loopbackConfig))
      : startDesktopLoopback(loopbackConfig);
    debugBridge.catch(() => { debugBridge = undefined; });
  }
  const proxies = new Map();
  // Resolve project IDs against the active Studio, never a renderer path. The
  // store calls this on every operation so a removed project loses access.
  async function verifyOfficialProject(projectId) {
    const studio = upstream;
    if (disposed || !studio || !/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) throw new Error('Project unavailable');
    const response = await fetch(new URL('/api/projects', studio.origin), {
      headers: { 'x-studio-key': studio.key, 'accept-encoding': 'identity' },
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok || Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('Project unavailable');
    const body = await response.text();
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('Project unavailable');
    const data = JSON.parse(body);
    const project = Array.isArray(data?.projects) ? data.projects.find(item => item?.id === projectId && !item.missing) : null;
    if (!project || typeof project.path !== 'string') throw new Error('Project unavailable');
    const path = await realpath(project.path);
    if (disposed || upstream !== studio) throw new Error('Project unavailable');
    return { projectId, path };
  }
  // Transcript files: an inline picture is read from a project Studio still lists,
  // and a product is handed to the operating system instead of the browser. Both
  // resolve the project through verifyOfficialProject, so a stale ID opens nothing.
  const projectFiles = createProjectFiles({ resolveProject: verifyOfficialProject });
  const preferences = createPreferencesStore();
  void preferences.get().then((p) => {
    if (p?.logRetentionDays) diagLog.setRetentionDays(p.logRetentionDays);
  }).catch(() => {});
  const projectParentDir = async (proxy) => {
    const projects = await proxy.listProjects();
    if (projects.length) return dirname(projects[0].path);
    // Studio's own library location. It used to be `~/OpenFilm`, which on a
    // developer's machine sat next to a checkout of this plugin — and a film
    // folder inside this repository makes the repository's AGENTS.md part of the
    // film conversation's instructions (see src/agent-overlays.mjs). Videos/OpenFilm
    // is where Studio itself puts projects, so the default follows it.
    return process.platform === 'win32'
      ? join(homedir(), 'Videos', 'OpenFilm', 'Projects')
      : join(homedir(), 'OpenFilm', 'Projects');
  };
  const createBlankOfficialProject = async (proxy, ratio, parentDir, setStage) => {
    const film = blankFilmHtml(ratio);
    setStage('prepare-directory');
    await mkdir(parentDir, { recursive: true });
    const target = join(parentDir, `自定义-${randomBytes(3).toString('hex')}`);
    await mkdir(target);
    setStage('write-blank');
    await writeFile(join(target, 'film.html'), film, { flag: 'wx' });
    setStage('register');
    const project = await proxy.createProject(target);
    if (!project || typeof project.id !== 'string' || typeof project.path !== 'string') throw new Error('Studio returned an invalid project');
    return { projectId: project.id, path: project.path };
  };
  const finishOnboardingProject = async (templateId, created, presets) => {
    const extra = {};
    if (presets && presets.ratio !== undefined) extra.customRatio = presets.ratio;
    if (presets && presets.seconds !== undefined) extra.customSeconds = Number(presets.seconds);
    if (presets && presets.language !== undefined) extra.customLanguage = presets.language;
    const prefs = await preferences.set({
      onboardingCompleted: true,
      defaultTemplateId: templateId,
      lastProjectId: created.projectId,
      ...extra,
    });
    return { ...created, prefs, onboarding: onboardingCopy(templateId, presets) };
  };
  const officialStore = () => {
    if (disposed) throw new Error('Studio disposed');
    if (!officialStorePromise) {
      officialStorePromise = openOfficialChatStore(ctx, { z, requireVerifiedProject: verifyOfficialProject });
      officialStorePromise.catch(() => { officialStorePromise = undefined; });
    }
    return officialStorePromise;
  };
  // Declared here, assigned once the ACP service is built below, so the host RPC
  // handlers can tell the two paths apart without reading a const before its
  // initialization (the bone this repo has broken twice).
  let nativeAgentService = null;
  // A failure reason for the log, never a filesystem path (the log is shared).
  const safeDetail = error => String(error?.message ?? '').replace(/[A-Za-z]:[\\/][^\s"']*/g, '[path]').slice(0, 160);
  const officialRpc = async (channel, payload, { proxy, traceId } = {}) => {
    if (disposed) throw new Error('Studio disposed');
    if (channel === 'skills:list') {
      if (!agentService) throw new Error('Agent bridge unavailable');
      const project = await verifyOfficialProject(payload?.projectId);
      return skillListing(await filmSkillCatalog(project.path));
    }
    if (channel === 'agent:prompt') {
      if (!agentService) throw new Error('Agent bridge unavailable');
      // The conversation is what the page's chat is: without it the Host would send
      // every project's turns into one DSH Session (the "new chat continues the old
      // one" bug). '' is the project's default conversation.
      const conversation = typeof payload?.conversation === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(payload.conversation) ? payload.conversation : '';
      return agentService.send(payload?.projectId, { conversation, key: payload?.key, turnId: payload?.turnId, text: payload?.text, images: payload?.images, skillIds: payload?.skillIds });
    }
    if (channel === 'agent:session') {
      // Read-only: never opens a Session just to answer a question about one.
      const projectId = typeof payload?.projectId === 'string' ? payload.projectId : '';
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) throw Object.assign(new Error('unknown project'), { code: 'PERMISSION_INPUT' });
      const conversation = typeof payload?.conversation === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(payload.conversation) ? payload.conversation : '';
      const state = agentService?.sessionState?.(projectId, conversation);
      return state ? { ok: true, ...state } : { ok: true, sessionId: null, resumed: false };
    }
    if (channel === 'agent:permission') {
      // What the panel needs to decide whether to ask: the decision remembered
      // for this project and the preset DSH itself reports as in force.
      const projectId = typeof payload?.projectId === 'string' ? payload.projectId : '';
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) throw Object.assign(new Error('unknown project'), { code: 'PERMISSION_INPUT' });
      // The proxy resolved this project for this very request. Repeat it as
      // defence in depth, but never let a second lookup cost the menu its row:
      // a vanished row is indistinguishable from "no permission" in the page.
      try { await verifyOfficialProject(projectId); }
      catch (error) { void log.warn('permission-project-unverified', { code: String(error?.code ?? error?.name ?? 'NONE').slice(0, 40), detail: safeDetail(error) }); }
      let store = null;
      try { store = await permissions(); }
      catch (error) { void log.warn('permission-store-failed', { code: String(error?.code ?? error?.name ?? 'NONE').slice(0, 40), detail: safeDetail(error) }); }
      const remembered = store ? store.remembered(projectId) ?? null : null;
      // The menu only draws the row when it has a value, so "no Session yet" (or
      // a Session that DSH reports nothing for) must not read as "no permission":
      // fall back to the decision and then to the default the bridge applies.
      const current = remembered ?? FULL_ACCESS;
      return {
        available: store ? store.available() : false, decided: remembered !== null, remembered, current,
        names: store ? store.names() : [], fullAccess: FULL_ACCESS, workspace: WORKSPACE_WRITE,
      };
    }
    if (channel === 'agent:permission-set') {
      const projectId = typeof payload?.projectId === 'string' ? payload.projectId : '';
      const preset = payload?.preset;
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) throw Object.assign(new Error('unknown project'), { code: 'PERMISSION_INPUT' });
      if (preset !== FULL_ACCESS && preset !== WORKSPACE_WRITE) throw Object.assign(new Error('unknown preset'), { code: 'PERMISSION_INPUT' });
      let store;
      try {
        await verifyOfficialProject(projectId);
        store = await permissions();
      } catch (error) {
        // A structured failure the page can show beats a bare 503: the row is
        // there, so the person who clicks it deserves a reason.
        void log.warn('permission-set-unavailable', { code: String(error?.code ?? error?.name ?? 'NONE').slice(0, 40), detail: safeDetail(error) });
        return { ok: false, preset: null, applied: false, error: String(error?.code ?? 'PERMISSION_STORE_UNAVAILABLE'), message: safeDetail(error) };
      }
      try {
        // The child cannot change its sandbox while running, so stop it: the next
        // turn spawns under the preset just chosen, read back from the decision.
        await nativeAgentService?.reset?.(projectId);
        await store.decide(projectId, preset);
        return { ok: true, preset, applied: false };
      } catch (error) {
        return { ok: false, preset: null, applied: false, error: String(error?.code ?? 'PERMISSION_FAILED'), message: String(error?.message ?? '') };
      }
    }
    if (channel === 'agent:cancel') {
      if (!agentService) throw new Error('Agent bridge unavailable');
      const conversation = typeof payload?.conversation === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(payload.conversation) ? payload.conversation : '';
      return agentService.cancel(payload?.projectId, conversation);
    }
    if (channel === 'agent:trace') {
      // The page's own count of what it received. Counters only: no text, no
      // paths, no keys — this exists so `/diagnose` can say whether a published
      // envelope reached the panel, not to log what the model said.
      const projectId = typeof payload?.projectId === 'string' ? payload.projectId : '';
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) throw Object.assign(new Error('unknown project'), { code: 'TRACE_INPUT' });
      // The page's counts, in the log too: "no thinking shown" is answered by
      // whether `agent_thought_chunk` appears here, without a live panel.
      const kinds = payload?.kinds && typeof payload.kinds === 'object' ? payload.kinds : {};
      // One flat string: the log sanitizer turns a nested object into "[object]".
      const summary = Object.entries(kinds).slice(0, 10).map(([key, value]) => `${String(key).slice(0, 32)}=${Number(value) || 0}`).join(' ').slice(0, 240);
      log.info('agent-trace', { projectId, seen: Number(payload?.seen) || 0, kinds: summary });
      return { ok: bridgeTrace.panel(projectId, { seen: payload?.seen, kinds: payload?.kinds }) };
    }
    if (channel === 'probe:drag') {
      // Evidence, not behaviour: which frame saw the drag at all.
      const clean = (value, size) => (typeof value === 'string' ? value.slice(0, size) : '');
      log.info('drag-probe', {
        layer: clean(payload?.layer, 8),
        type: clean(payload?.type, 16),
        types: clean(payload?.types, 60),
        files: Number(payload?.files) || 0,
        target: clean(payload?.target, 20),
      });
      return { ok: true };
    }
    if (channel === 'client:log') {
      const event = typeof payload?.event === 'string' ? payload.event : '';
      if (!CLIENT_EVENTS.has(event)) throw Object.assign(new Error('unknown client event'), { code: 'CLIENT_EVENT_UNKNOWN' });
      log.info(`page-${event}`, {
        anchor: typeof payload?.anchor === 'string' ? payload.anchor.slice(0, 16) : undefined,
        detail: typeof payload?.detail === 'string' ? payload.detail.slice(0, 40) : undefined,
      });
      return { ok: true };
    }
    if (channel === 'editor:link') {
      // One-use ticket for the local Studio page, minted only after the Host has
      // authenticated this call. Never cached, never logged.
      if (!proxy || typeof proxy.issueTicket !== 'function') throw Object.assign(new Error('Studio is not ready'), { code: 'EDITOR_LINK_UNAVAILABLE' });
      return proxy.issueTicket();
    }
    if (channel === 'environment:check') {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 0) {
        throw Object.assign(new Error('Invalid environment check'), { code: 'ENVIRONMENT_INPUT' });
      }
      // Coalesce simultaneous requests but always probe again after completion.
      if (!componentCheck) componentCheck = detectHostComponents().finally(() => { componentCheck = undefined; });
      const tools = await componentCheck;
      const asr = await transcribeService.status();
      return {
        ...tools,
        arch: process.arch,
        asr: {
          ready: asr.ready === true,
          installing: asr.installing === true,
          phase: asr.phase || 'idle',
          error: typeof asr.error === 'string' ? asr.error.slice(0, 300) : '',
          dir: typeof asr.dir === 'string' ? asr.dir : '',
        },
      };
    }
    if (channel === 'environment:fallback-prompt') {
      const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const kindRaw = typeof body.kind === 'string' ? body.kind : 'tools';
      const kind = ['tools', 'asr', 'both', 'path-fix'].includes(kindRaw) ? kindRaw : 'tools';
      const directory = typeof body.directory === 'string' ? body.directory.slice(0, 2048) : '';
      const mode = body.mode === 'installed' || kind === 'path-fix' ? 'installed' : '';
      let error = typeof body.error === 'string' ? body.error.slice(0, 500) : '';
      if (!error && (kind === 'asr' || kind === 'both')) {
        try {
          const asr = await transcribeService.status();
          if (asr?.error) error = String(asr.error).slice(0, 500);
        } catch { /* status is best-effort for the prompt */ }
      }
      if (!error && (kind === 'tools' || kind === 'both') && typeof toolInstaller?.snapshot === 'function') {
        try {
          const snap = await toolInstaller.snapshot();
          const parts = ['ffmpeg', 'ffprobe']
            .map(name => snap?.tools?.[name])
            .filter(row => row?.error)
            .map(row => String(row.error).slice(0, 160));
          if (parts.length) error = parts.join('；');
        } catch { /* ignore */ }
      }
      const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
      return buildFallbackPayload(kind === 'path-fix' ? 'path-fix' : kind, {
        platform: process.platform,
        arch: process.arch,
        env: process.env,
        error,
        directory,
        mode: kind === 'path-fix' ? 'installed' : mode,
        home: dshHome,
        toolsDir: join(dshHome, 'no996-openfilm', 'tools'),
      });
    }
    if (
      channel === 'auth:status' || channel === 'auth:logout' || channel === 'auth:action' || channel === 'account:balance'
      || channel === 'account:overview' || channel === 'account:traces' || channel === 'account:pricing'
      || channel === 'auth:remember-get' || channel === 'auth:remember-set' || channel === 'auth:remember-clear'
    ) {
      // Login + account panel live inside the official shell. Tokens stay on Host.
      if (channel === 'auth:remember-get') {
        const remembered = await loginRemember.get();
        return {
          enabled: remembered.enabled === true && Boolean(remembered.account),
          account: remembered.account || '',
          // Password only for autofill on this machine's login form; never log it.
          password: remembered.enabled ? (remembered.password || '') : '',
        };
      }
      if (channel === 'auth:remember-set') {
        const body = payload && typeof payload === 'object' ? payload : {};
        if (body.enabled === false || body.clear === true) return loginRemember.clear();
        await loginRemember.set({
          account: body.account,
          password: body.password,
          enabled: body.enabled !== false,
        });
        return { ok: true, enabled: true, account: String(body.account || '').trim().slice(0, 160) };
      }
      if (channel === 'auth:remember-clear') {
        return loginRemember.clear();
      }
      if (channel === 'auth:status') {
        const status = await workbenchAuth.status();
        const guest = status.guest === true;
        const wallet = guest || status.dev === true
          ? { available_points: 0, points_balance: 0, period_points_balance: 0, expert_points_balance: 0, period_expires_at: null }
          : balanceFromPrefs(await preferences.get());
        return {
          loggedIn: status.loggedIn === true,
          dev: status.dev === true,
          guest,
          account: typeof status.account === 'string' ? status.account : '',
          displayName: typeof status.displayName === 'string' ? status.displayName : '',
          // Chip uses cached available points (permanent + period). Fresh pull is account:balance.
          // Guest / dev never show a leftover wallet from a previous real login.
          credits: wallet.available_points,
          balance: wallet,
        };
      }
      if (channel === 'account:balance') {
        const refresh = !(payload && typeof payload === 'object' && payload.refresh === false);
        const cached = balanceFromPrefs(await preferences.get());
        if (!refresh) {
          if (workbenchAuth.guest || workbenchAuth.dev) {
            return { available_points: 0, points_balance: 0, period_points_balance: 0, expert_points_balance: 0, period_expires_at: null, stale: false, source: workbenchAuth.dev ? 'dev' : 'guest', ...(workbenchAuth.dev ? { dev: true } : { guest: true }) };
          }
          return { ...cached, stale: false, source: 'cache' };
        }
        if (workbenchAuth.dev) {
          const live = await workbenchAuth.balance();
          await preferences.set(balanceCachePatch(live));
          return { ...balanceFromPrefs(await preferences.get()), stale: false, source: 'dev', dev: true };
        }
        if (workbenchAuth.guest) {
          const live = await workbenchAuth.balance();
          return { ...live, stale: false, source: 'guest', guest: true };
        }
        try {
          const live = await workbenchAuth.balance();
          await preferences.set(balanceCachePatch(live));
          return { ...balanceFromPrefs(await preferences.get()), stale: false, source: 'live' };
        } catch (error) {
          return {
            ...cached,
            stale: true,
            source: cached.cached_at ? 'cache' : 'none',
            error: String(error?.code || 'BALANCE'),
            message: String(error?.message || '积分暂不可用').slice(0, 200),
          };
        }
      }
      if (channel === 'account:overview') {
        const status = await workbenchAuth.status();
        const isFormal = status.loggedIn === true && status.guest !== true && status.dev !== true;
        let balance = isFormal ? balanceFromPrefs(await preferences.get()) : { available_points: 0, points_balance: 0, period_points_balance: 0, expert_points_balance: 0, period_expires_at: null };
        if (isFormal) {
          try {
            const live = await workbenchAuth.balance();
            await preferences.set(balanceCachePatch(live));
            balance = { ...balanceFromPrefs(await preferences.get()), stale: false };
          } catch {
            balance = { ...balance, stale: true };
          }
        }
        let capabilities = null;
        if (isFormal) {
          capabilities = await workbenchAuth.authedRequest('/api/v1/me/api-capabilities').catch(() => null);
        }
        return { status, balance, capabilities, walletDirtyAt };
      }
      if (channel === 'account:traces') {
        const status = await workbenchAuth.status();
        if (!(status.loggedIn === true && status.guest !== true && status.dev !== true)) {
          return { items: [], total: 0, page: 1, page_size: 20 };
        }
        const body = payload && typeof payload === 'object' ? payload : {};
        const page = Math.max(1, Number(body.page) || 1);
        const pageSize = Math.min(50, Math.max(1, Number(body.pageSize) || 20));
        const mode = body.mode === 'ledgers' ? 'ledgers' : 'traces';
        if (mode === 'ledgers') {
          const data = await workbenchAuth.authedRequest(`/api/v1/account/ledgers?page=${page}&page_size=${pageSize}`).catch(() => ({ items: [], total: 0 }));
          return { mode, page, page_size: pageSize, items: Array.isArray(data?.items) ? data.items : [], total: Number(data?.total) || 0 };
        }
        const data = await workbenchAuth.authedRequest(`/api/v1/billing/traces?page=${page}&page_size=${pageSize}`).catch(() => ({ items: [], total: 0 }));
        return { mode, page, page_size: pageSize, items: Array.isArray(data?.items) ? data.items : [], total: Number(data?.total) || 0 };
      }
      if (channel === 'account:pricing') {
        const status = await workbenchAuth.status();
        if (!(status.loggedIn === true && status.guest !== true && status.dev !== true)) {
          return { models: [], services: [], capabilities: null };
        }
        const [catalog, capabilities] = await Promise.all([
          workbenchAuth.authedRequest('/api/v1/pricing/catalog').catch(() => ({ items: [], models: [], services: [] })),
          workbenchAuth.authedRequest('/api/v1/me/api-capabilities').catch(() => null),
        ]);
        const rawItems = Array.isArray(catalog?.items) ? catalog.items : [];
        const mappedModels = Array.isArray(catalog?.models) && catalog.models.length > 0
          ? catalog.models
          : rawItems.filter((it) => it?.category === 'model').map((it) => ({
            model_code: it.code,
            display_name: it.display_name || it.code,
            points_per_1k_input: Number(it.input_points_per_1k) || 0,
            points_per_1k_output: Number(it.output_points_per_1k) || 0,
            fixed_points: Number(it.fixed_points) || 0,
            billing_mode: String(it.billing_mode || ''),
            supports_vision: Boolean(it.image_input),
            available: it.ready !== false,
          }));
        const mappedServices = Array.isArray(catalog?.services) && catalog.services.length > 0
          ? catalog.services
          : rawItems.filter((it) => it?.category === 'service').map((it) => ({
            service_code: it.code,
            display_name: it.display_name || it.code,
            unit_label: it.metering_unit || '次',
            points_per_unit: Number(it.unit_points) || 0,
            available: it.ready !== false,
          }));
        return {
          models: mappedModels,
          services: mappedServices,
          auto_vision_routing_enabled: Boolean(catalog?.auto_vision_routing_enabled ?? capabilities?.auto_vision_routing_enabled ?? true),
          gateway_base_url: catalog?.gateway_base_url || capabilities?.gateway_base_url || '',
          capabilities,
        };
      }
      if (channel === 'auth:logout') {
        // A dev session has nothing to log out of; clearing it would only bounce
        // the person back to a gate that accepts nothing.
        if (workbenchAuth.dev) return { loggedIn: true, dev: true };
        await workbenchAuth.logout();
        await preferences.set(clearBalanceCachePatch());
        void refreshVoiceChoice();
        onAuthChanged?.();
        return { loggedIn: false };
      }
      // DEV still needs a captcha payload for LoginGate styling/preview.
      // Other auth:action calls stay short-circuited (no real login/register).
      if (workbenchAuth.dev) {
        const action = payload && typeof payload === 'object' ? payload : {};
        if (action.action === 'captcha') {
          try {
            return await dispatchAuthAction(workbenchAuth, action);
          } catch (error) {
            return {
              ok: false,
              error: String(error?.code || 'AUTH'),
              message: String(error?.message || '请求失败').slice(0, 200),
            };
          }
        }
        return { ok: true, dev: true };
      }
      const action = payload && typeof payload === 'object' ? payload : {};
      try {
        const result = await dispatchAuthAction(workbenchAuth, action);
        void refreshVoiceChoice();
        onAuthChanged?.();
        void nativeAgentService?.refreshDefaultModels?.().catch(() => {});
        return result;
      } catch (error) {
        // Page needs the workbench message, not a bare 503. Tokens never leave Host.
        return {
          ok: false,
          error: String(error?.code || 'AUTH'),
          message: String(error?.message || '请求失败').slice(0, 200),
          ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
        };
      }
    }
    if (channel === 'system:check') return system.snapshot();
    if (channel === 'system:install') {
      const tool = payload && typeof payload === 'object' && typeof payload.tool === 'string' ? payload.tool : 'all';
      system.install(tool);
      return system.snapshot();
    }
    if (channel === 'asr:status' || channel === 'asr:install') {
      // Same service as /api/no996-openfilm/asr, exposed over the one bridge the
      // overlays are allowed to use. Install starts once and joins the download.
      const state = await transcribeService.status();
      if (channel === 'asr:install' && !state.ready) void transcribeService.setup().catch(() => undefined);
      return {
        ready: state.ready, dir: state.dir, bytesTotal: state.bytesTotal, bytesOnDisk: state.bytesOnDisk,
        progress: state.progress, installing: state.installing || (channel === 'asr:install' && !state.ready),
        engine: state.engine,
      };
    }
    if (channel === 'prefs:get') {
      return { prefs: await preferences.get() };
    }
    if (channel === 'prefs:set') {
      const prefs = await preferences.set(payload && typeof payload === 'object' ? payload : {});
      return { prefs };
    }
    if (channel === 'template:list') {
      const templates = await listTemplates(templatesRoot);
      const prefs = await preferences.get();
      const cards = templates.map((item) => {
        const meta = productMeta(item.id);
        return meta ? { ...item, ...meta } : item;
      });
      const custom = productMeta('custom');
      cards.push({
        id: 'custom',
        title: custom.productTitle,
        description: custom.productBlurb,
        mode: 'blank',
        entry: '',
        prompt: '',
        ...custom,
      });
      return { templates: cards, prefs };
    }
    if (channel === 'template:create' || channel === 'project:create-blank') {
      const templateId = channel === 'project:create-blank' ? 'custom' : payload?.templateId;
      const kind = templateId === 'custom' ? 'blank' : 'template';
      let stage = 'proxy';
      const setStage = next => { stage = next; };
      try {
        if (!proxy || typeof proxy.createProject !== 'function') throw new Error('Studio is not ready');
        const presets = kind === 'blank' && payload && typeof payload === 'object'
          ? { ratio: payload.ratio, seconds: payload.seconds, language: payload.language }
          : undefined;
        stage = 'validate';
        const chosen = kind === 'template' ? (await listTemplates(templatesRoot)).find(item => item.id === templateId) : null;
        if (kind === 'template' && !chosen) throw Object.assign(new Error('Unknown template'), { code: 'TEMPLATE_INPUT' });
        stage = 'list-projects';
        const parentDir = await projectParentDir(proxy);
        stage = 'prepare-directory';
        const created = chosen ? await installTemplate({
          root: templatesRoot, id: chosen.id, parentDir, createProject: target => proxy.createProject(target),
          titleFor: () => chosen.title, setStage,
        }) : await createBlankOfficialProject(proxy, presets?.ratio, parentDir, setStage);
        // Bookkeeping failures must not hide a project already registered in Studio.
        const finished = await finishTemplateCreation(created, {
          activate: chosen ? () => writeActiveTemplates(created.path, [chosen.id]) : () => {},
          remember: () => finishOnboardingProject(templateId, created, presets),
        });
        for (const code of finished.warnings ?? []) {
          diagLog.warn({ layer: 'host', code, channel, traceId, projectId: created.projectId,
            summary: 'Project was created; optional bookkeeping failed', detail: { kind, stage: 'bookkeeping' } });
        }
        return chosen ? { ...finished, prompt: chosen.prompt } : finished;
      } catch (error) {
        const uncertain = stage === 'register';
        const code = uncertain ? 'TEMPLATE_REGISTRATION_UNCERTAIN'
          : ['TEMPLATE_INPUT', 'TEMPLATE_TOO_LARGE', 'TEMPLATE_ROOT', 'TEMPLATE_TARGET'].includes(error?.code) ? error.code
          : ['proxy', 'list-projects'].includes(stage) ? 'TEMPLATE_UNAVAILABLE'
          : ['copy', 'write-blank'].includes(stage) ? 'TEMPLATE_COPY_FAILED'
          : stage === 'template-preflight' ? 'TEMPLATE_SOURCE_FAILED' : 'TEMPLATE_PREPARE_FAILED';
        const cause = error?.cause ?? error;
        const detail = { kind, stage, systemCode: studioSystemCode(cause),
          upstreamStatus: Number.isInteger(cause?.upstreamStatus) ? cause.upstreamStatus : null,
          folderMayRemain: uncertain || stage === 'copy' || stage === 'write-blank', registrationUnknown: uncertain };
        const location = 'src/studio/studio-controller.mjs:project-create';
        if (!traceId) diagLog.error({ layer: 'host', code, channel, location, summary: code, detail });
        throw Object.assign(new Error(code), { code, diag: { ...detail, layer: 'host', location } });
      }
    }
    if (channel === 'diag:list' || channel === 'diag:export' || channel === 'diag:clear' || channel === 'diag:prefs') {
      return diagLogs.handleRpc(channel, payload);
    }
    // chat:load/save and the archive channels share the same Host-side state:
    // an archived project withholds history and refuses writes, and both
    // surfaces (DSH sidebar, this panel) mutate the same durable set.
    return createOfficialChatRpc(await officialStore(), agentService, {
      state: archiveState,
      archive: async projectId => { const current = await archiveState(projectId); await archive.archive(current.sessionId, { stopActivity: true }); },
      unarchive: async projectId => { const current = await archiveState(projectId); await archive.unarchive(current.sessionId); },
      // The trace tab's reading: what this turn called and what came back.
      turnLog: turnLogOf,
      // A degraded optional surface (the thinking menu) says why here instead of
      // raising a 503 the person has to read.
      log: (event, fields) => { void log.info(event, fields); },
    })(channel, payload);
  };
  // Stage 1 trust model: the editor origin is the official OpenFilm window for
  // this local DSH user (the same trust upstream's desktop app gives its own
  // window). A project ID is still checked against Studio's live project list,
  // so a stale or invented ID is refused. Cross-project reading inside that
  // trusted window matches upstream, not a new privilege; a signed per-frame
  // scope can replace this later without changing the page.
  const authorizeOfficialProject = async (_req, projectId) => {
    try { await verifyOfficialProject(projectId); return true; } catch { return false; }
  };
  // Session permission for a project's conversation. Resolved lazily: a page
  // that never opens a project never touches the permission domain.
  const permissions = () => {
    if (!permissionsPromise) {
      permissionsPromise = openProjectPermissions(ctx, { z, onFailure: (event, fields) => { void log.warn(event, fields); } });
      permissionsPromise.catch(error => {
        void log.warn('permission-store-open-failed', { code: String(error?.code ?? error?.name ?? 'NONE').slice(0, 40), detail: safeDetail(error) });
        permissionsPromise = undefined;
      });
    }
    return permissionsPromise;
  };
  const dshFilmDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'no996-openfilm');
  const nativeSessions = createDshSessionStore({ file: join(dshFilmDir, 'native-sessions.json') });
  // Pin and display name of a project in the editing area; cosmetic and local to
  // this list (never the project's real name or the DSH Session title).
  const editingPrefs = createEditingPrefs({ file: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'no996-openfilm', 'editing-prefs.json') });
  // The only irreversible folder action: guarded move to `<projects root>/../.no996-trash`
  // (or an explicit permanent delete). Kept injectable for tests.
  const projectTrash = createProjectTrash();
  // Deleting must not depend on Studio still listing the project: a folder Studio
  // never indexed is exactly the one people ask to remove, and it used to answer
  // 404 while the row sat on screen. The ACP binding is Host-owned and carries the
  // path, so it is the fallback identity. The move itself stays guarded by
  // project-trash (realpath, marker files, home/root, already-trashed).
  async function resolveDeleteTarget(projectId) {
    try {
      const identity = await verifyOfficialProject(projectId);
      return { ...identity, source: 'studio' };
    } catch { /* fall back to the binding */ }
    const record = nativeSessions.get(projectId);
    if (record && typeof record.cwd === 'string' && record.cwd) {
      try {
        const path = await realpath(record.cwd);
        return { projectId, path, source: 'binding' };
      } catch { /* the folder is already gone; the records still need clearing */ }
    }
    throw Object.assign(new Error('Studio does not know this project and no binding has its path'), { code: 'UNKNOWN_PROJECT' });
  }

  const deleteEditingProject = createEditingProjectDelete({
    verifyProject: resolveDeleteTarget,
    acpSessions: nativeSessions,
    editingPrefs,
    officialStore,
    archive,
    trash: projectTrash,
    reset: projectId => nativeAgentService?.reset?.(projectId),
    log,
  });
  /** Read a small JSON request body; returns {} on anything malformed. */
  // Archive state of a project's bound conversation. Always resolved in the
  // Host: the page supplies a project ID and never a Session ID. This never
  // creates a Session — reading chat history must not have that side effect.
  const archiveState = async projectId => {
    await verifyOfficialProject(projectId);
    const acp = nativeSessions.get(projectId);
    if (!acp || typeof acp.sessionId !== 'string') return { sessionId: null, archived: false, available: archive.available };
    return { sessionId: acp.sessionId, archived: archive.isArchived(acp.sessionId) === true, available: archive.available };
  };
  const beforeProjectDelete = async projectId => {
    try { await nativeAgentService?.reset?.(projectId); } catch { /* the delete still has to run */ }
    try {
      const current = await archiveState(projectId);
      if (current.sessionId && !current.archived) await archive.archive(current.sessionId, { stopActivity: true });
    } catch { /* the delete still has to run */ }
  };
  const chatTrace = createChatTrace();
  if (chatTrace.enabled) void log.info('chat-trace', { enabled: true, dir: tmpdir() + '\\no996-editor\\trace' });
  const isProjectAgent = agent => Boolean(agent && !disposed && nativeAgentService?.isProjectAgent?.(agent));
  // One project-scoped event fan-out feeds the official chat's stream.
  const eventHub = createOfficialEventHub();
  // Every envelope that goes to the panel is also kept, per project and turn, as
  // the trace tab's reading: the tab renders one line per event, so what the turn
  // called (tool name, arguments, result) is finally visible instead of only the
  // chat's three-word action rows. Bounded: a long turn keeps its last events.
  const { recordTurnEvent, turnLogOf } = createTurnLog();
  // Approval questions travel the same stream as transcript updates. `publish`
  // reports whether a live transport accepted the write, which is exactly the
  // coordinator's delivery contract (acceptance, not proof of rendering).
  const deliverToPanel = (projectId, event) => {
    const delivered = eventHub.publish(projectId, event);
    bridgeTrace.emit(projectId, event, delivered);
    recordTurnEvent(projectId, event);
    chatTrace.record(projectId, event);
    return delivered;
  };
  const approvals = createOfficialApprovals({ deliver: deliverToPanel });
  // The panel's conversation is an ACP child. The agent owns the Session, so the
  // panel and the sidebar share one conversation and the shell's own ACP surface
  // (thinking, tools, resume, model menu) is exactly what the page draws.
  const prepareProjectInstructions = async (projectId, projectPath) => {
    const result = ensureProjectInstructions({ root: projectPath });
    if (result.created) void log.info('project-instructions', { projectId });
    else {
      const upgraded = upgradeProjectInstructions({ root: projectPath });
      if (upgraded.upgraded) void log.info('project-instructions-upgraded', { projectId });
    }
  };

  nativeAgentService = createDshNativeAgentService({
    ctx,
    verifier: verifyOfficialProject,
    store: nativeSessions,
    emit: async (projectId, event) => deliverToPanel(projectId, event),
    prepareProject: prepareProjectInstructions,
    defaultSelection: async () => {
      try {
        const status = await workbenchAuth.status().catch(() => null);
        if (status?.loggedIn && !status?.guest && !status?.dev) {
          const providers = ctx.llm?.listProviders?.() ?? [];
          if (providers.some(p => p?.id === 'no996')) {
            return { provider: 'no996', model: 'auto' };
          }
        }
      } catch { /* ignore and fall back */ }
      try {
        const current = ctx.agentDefaultModel?.currentSelection?.();
        if (current && (current.provider || current.model)) return current;
      } catch { /* ignore */ }
      return undefined;
    },
    log: (event, fields) => void log.info(event, fields),
    diag: diagLog,
  });
  const agentService = officialShell ? nativeAgentService : null;
  const guideTool = createGuideTool(isProjectAgent);
  const unregisterGuide = ctx.tools.register(guideTool, { when: ({ agent }) => isProjectAgent(agent) });
  // One Studio client for every project tool: it resolves the live upstream, adds
  // the key the page must never see, and turns a failure into readable text.
  const studioHttp = () => {
    if (!httpClient) {
      httpClient = createStudioHttp({
        studio: async () => {
          // A closed panel is not a reason to refuse: starting Studio here is what
          // the panel would have done, and it is the same process.
          try { await runtime.ensureStarted(); } catch { /* fall through: the tool reports it */ }
          return upstream ? { origin: upstream.origin, key: upstream.key } : undefined;
        },
      });
    }
    return httpClient;
  };
  // Upstream release-note visibility is decided in the annotated shell patch;
  // the Host must not alter the person's Studio seenVersion preference.
  // The project an agent may edit, resolved from the Host's own record. Never from
  // a renderer-supplied id.
  const projectOfAgent = agent => {
    const native = nativeAgentService?.projectOfAgent?.(agent);
    return native ? { projectId: native.projectId, path: native.path, conversation: native.conversation ?? '', available: true } : undefined;
  };
  const filmTools = [
    createFrameTool({ isProjectAgent, projectOf: projectOfAgent, http: studioHttp, attachments: () => ctx.get('attachments'), llm: () => ctx.llm }),
    ...createVisionTools({ isProjectAgent, projectOf: projectOfAgent, attachments: () => ctx.get('attachments') }),
    createFilmTool({ isProjectAgent, projectOf: projectOfAgent, http: studioHttp }),
    createFontsTool({ isProjectAgent, projectOf: projectOfAgent, http: studioHttp }),
    createKitTool({ isProjectAgent, projectOf: projectOfAgent }),
    createAudioTool({ isProjectAgent, projectOf: projectOfAgent }),
    createRhythmTool({ isProjectAgent, projectOf: projectOfAgent }),
    createSfxTool({ isProjectAgent, projectOf: projectOfAgent }),
    createModeTool({
      isProjectAgent,
      projectOf: projectOfAgent,
      getMode: (projectId, conversation) => nativeAgentService?.getWorkMode?.(projectId, conversation),
      setMode: (projectId, conversation, next) => nativeAgentService?.setWorkMode?.(projectId, conversation, next),
    }),
    createLibraryTool({
      isProjectAgent,
      projectOf: projectOfAgent,
      http: studioHttp,
      templates: async () => (await Promise.all([
        templateCatalog(templatesRoot), templateCatalog(externalTemplateRoot(), { source: 'external' }),
      ])).flat(),
      templateDetail: id => id.startsWith('external:')
        ? templateDetails(externalTemplateRoot(), id.slice('external:'.length), { source: 'external' })
        : templateDetails(templatesRoot, id),
      activateTemplate: async (projectPath, id) => {
        const active = readActiveTemplates(projectPath);
        return { active: writeActiveTemplates(projectPath, active.includes(id) ? active : [id, ...active]) };
      },
    }),
    // Plan before cutting: the storyboard is the contract the timeline follows, and
    // "from-script" turns a transcript into shots on sentence boundaries.
    createStoryboardTool({ isProjectAgent, projectOf: projectOfAgent }),
    createGetTool({ isProjectAgent, projectOf: projectOfAgent, http: studioHttp, prepareVoice: voiceSettings.prepare }),

    createClipTool({ isProjectAgent, projectOf: projectOfAgent, http: studioHttp }),
    createAssetsTool({ isProjectAgent, projectOf: projectOfAgent, http: studioHttp }),
    createExportTool({
      isProjectAgent,
      projectOf: projectOfAgent,
      http: studioHttp,
      getWorkMode: (projectId, conversation) => nativeAgentService?.getWorkMode?.(projectId, conversation),
    }),
    createCliTool({ isProjectAgent, projectOf: projectOfAgent }),
  ];
  const unregisterFilmTools = filmTools.map(tool => ctx.tools.register(tool, { when: ({ agent }) => isProjectAgent(agent) }));
  // Hydration is intentionally lazy: nothing claims a persisted Session on
  // startup. Opening a project in the video panel resolves or creates its
  // conversation, so a missing hint can never block the UI.
  const askAgent = createDshAskAgent({ llm: ctx.llm, agentDefaultModel: ctx.agentDefaultModel });

  // Local transcription. The engine that hears runs on this CPU; the model that
  // polishes product names is the session's. Registered here rather than with the
  // other tools because that polish pass needs askAgent, which is built above the
  // Studio runtime and below the tool list.
  const transcribeService = createTranscribeService({ logger: log });
  const transcribeTool = createTranscribeTool({
    isProjectAgent,
    projectOf: projectOfAgent,
    service: transcribeService,
    refine: ({ segments, signal }) => refineTranscript({ ask: askAgent, segments, signal }),
  });
  const unregisterTranscribe = ctx.tools.register(transcribeTool, { when: ({ agent }) => isProjectAgent(agent) });
  // The install path the panel can use without a chat turn: a fresh machine needs
  // 228 MB of weights, and the person should be able to start that from the UI.
  // The film tools, for the ACP child. No cookie admission: the caller is the
  // child process and proves itself with the per-Session bearer token above.
  const router = createRouter({ webServer: ctx.webServer, log });
  const registerRoute = router.register;
  const trackRoute = router.track;
  const rollbackRoutes = router.rollback;

  // System capability (installed tools, downloads, ASR weights): one snapshot
  // shared by the Host RPC and the panel routes, defined in its own module.
  const system = createSystemRoutes({ ctx, register: registerRoute, transcribeService, toolInstaller, detectHostComponents });
  const [unregisterTranscribeRoute, unregisterSystemCheck, unregisterSystemInstall] = system.disposers;
  const devHmrRequested = !releaseBuild && process.env.NO996_OPENFILM_DEV_HMR === '1';
  const resolveShellForRuntime = async () => {
    if (devHmrRequested) {
      // In Vite HMR mode, UI comes from the Vite Dev Server, not Studio's
      // static sendEditor; return the fallback ui directory if present so
      // startStudio starts /api/* cleanly even without an updated snapshot.
      const fallback = fileURLToPath(new URL('../../vendor/official-shell/ui', import.meta.url));
      return fallback;
    }
    return resolveOfficialShell();
  };
  const runtime = createStudioRuntime({ askAgent, ...(officialShell ? { resolveEditorDir: resolveShellForRuntime } : {}), attach: async studio => {
    upstream = studio;
    if (browserPortal && !disposed) {
      void browserPortal.setUpstream(studio).catch(() => {});
    }
    return async () => {
      upstream = undefined;
      if (browserPortal) {
        await browserPortal.setUpstream(null).catch(() => {});
      }
      const pending = [...proxies.values()];
      proxies.clear();
      lastProxy = undefined;
      const settled = await Promise.allSettled(pending);
      await Promise.all(settled.filter(item => item.status === 'fulfilled').map(item => item.value.close()));
    };
  } });
  ensureStudioForPortal = () => runtime.ensureStarted();
  const attachOfficialEvents = ({ projectId, res, req }) => {
    if (disposed) { res.destroy(); return; }
    // A reconnecting page names the last sequence it applied; the hub replays only
    // what came after it, so the turn resumes instead of restarting or losing its middle.
    let afterSeq;
    try {
      const value = new URL(req?.url ?? '', 'http://proxy.invalid').searchParams.get('afterSeq');
      if (value !== null && /^\d{1,12}$/.test(value)) afterSeq = Number(value);
    } catch { /* no cursor: a fresh stream */ }
    attachOfficialEventStream({ hub: eventHub, projectId, response: res, ...(afterSeq === undefined ? {} : { afterSeq }) });
  };
  const devAnyFlag = !releaseBuild && devEnvRequested;
  let devExtension = null;
  let devReady = Promise.resolve(null);
  function proxyFor(browserOrigin, desktop = false) {
    const existing = proxies.get(browserOrigin);
    if (existing) return existing;
    const browser = new URL(browserOrigin);
    // The proxy validates its own Host and Origin before this callback. DSH's
    // cookie is bound to the browser's actual authority, not the bind address.
    const authenticateBrowser = req => {
      if (disposed) return false;
      const headers = { ...req.headers, host: browser.host, origin: browserOrigin };
      const admission = ctx.connection.admit({ headers });
      return !('rejection' in admission) && admission.peer.id === ctx.connection.browserPeer.id;
    };
    const pending = Promise.resolve(devReady).then((ext) => createProxy({
      upstream,
      webOrigin: browserOrigin,
      authenticateBrowser,
      desktop,
      officialShell,
      log,
      diagLog,
      devHooks: ext?.devHooks ?? null,
      beforeProjectDelete,
      voiceSettings,
      rewriteLibraryVoices: async () => {
        try {
          const choice = await voiceSettings.prepare();
          if (choice.selected !== 'no996') return null;
          return await voiceBridge.libraryVoicesPayload();
        } catch {
          return { version: 1, providers: [{ id: 'no996', name: '不加班', models: [{ id: 'workbench-tts', name: '不加班配音' }] }], voices: [] };
        }
      },
      ...(officialShell ? { officialRpc, authorizeOfficialProject, attachOfficialEvents, readProjectFile: projectFiles.read, openProjectFile: projectFiles.open } : {}),
    })).then(async next => {
      if (!next || typeof next.bootstrap !== 'function' || typeof next.close !== 'function' || typeof next.editorOrigin !== 'string' || disposed) {
        await next?.close?.();
        throw new Error('Studio proxy is unavailable');
      }
      if (proxies.get(browserOrigin) === pending) lastProxy = pending;
      return next;
    });
    proxies.set(browserOrigin, pending);
    pending.catch(() => { if (proxies.get(browserOrigin) === pending) proxies.delete(browserOrigin); });
    return pending;
  }
  let unregisterTemplateBridge;
  let unregisterAuthBridge;
  let unregisterArchiveBridge;
  let unregisterAttachment;
  let unregisterClientLog;
  let diagLogs;
  try {
  unregisterTemplateBridge = trackRoute(registerTemplateBridge(ctx, {
    webOrigin,
    list: () => listTemplates(templatesRoot),
    create: async (templateId, { origin, desktop }) => {
      await runtime.ensureStarted();
      const proxy = await proxyFor(origin, desktop);
      return officialRpc('template:create', { templateId }, { proxy });
    },
    isDisposed: () => disposed,
  }));
  unregisterAuthBridge = trackRoute(registerAuthBridge(ctx, {
    webOrigin,
    auth: workbenchAuth,
    isDisposed: () => disposed,
    onAuthChanged: () => {
      void refreshVoiceChoice();
      onAuthChanged?.();
      void nativeAgentService?.refreshDefaultModels?.().catch(() => {});
    },
  }));
  unregisterArchiveBridge = trackRoute(registerArchiveBridge(ctx, {
    webOrigin,
    state: archiveState,
    archive: async projectId => {
      const current = await archiveState(projectId);
      if (!current.sessionId) return current; // nothing bound yet, nothing to hide
      await archive.archive(current.sessionId, { stopActivity: true });
      return { sessionId: current.sessionId, archived: true, available: archive.available };
    },
    unarchive: async projectId => {
      const current = await archiveState(projectId);
      if (!current.sessionId) return current;
      await archive.unarchive(current.sessionId);
      return { sessionId: current.sessionId, archived: false, available: archive.available };
    },
    // Under ACP there is no Host-side binding to repair: forgetting the recorded
    // Session makes the next turn open a fresh one in the (possibly moved) folder.
    rebind: async projectId => {
      await verifyOfficialProject(projectId);
      nativeSessions.remove(projectId);
      await nativeAgentService?.reset?.(projectId);
      return { sessionId: null, archived: false, available: archive.available };
    },
    isDisposed: () => disposed,
  }));
  // Who the film agent is told to be, and which instruction files it reads. The
  // chain is computed here (not in the route) so the routes stay about evidence.
  // Shared by /diagnose (per-turn evidence) and /environment (what the film
  // agent can load: preset, skill gate, tools, chain).
  const describeInstructions = path => {
    const chain = instructionChain({
      cwd: path,
      dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
      agentsHome: join(homedir(), '.agents'),
    });
    // The resident budget: identity + instruction files. Everything else (guides,
    // skills, library, templates) is read on demand, so this number is the one that
    // must not grow with the number of styles or templates (agent-plan §7).
    const persona = Buffer.byteLength(PERSONA, 'utf8');
    const files = chain.files.reduce((sum, entry) => sum + entry.bytes, 0);
    const total = persona + files;
    return {
      persona,
      ...chain,
      budget: { persona, files, total, limit: 6144, ok: total <= 6144 },
    };
  };
  const projectPathOf = async projectId => {
    try { return (await verifyOfficialProject(projectId))?.path ?? null; } catch { return null; }
  };
  // Diagnose (evidence for "the panel shows nothing") lives in its own module.
  const diagnose = createDiagnoseRoute({
    ctx,
    register: registerRoute,
    track: trackRoute,
    log,
    officialShell,
    archive,
    bridgeTrace,
    runtime,
    permissions,
    agentService,
    getLastProxy: () => lastProxy,
    instructions: describeInstructions,
    projectPathOf,
  });
  const [unregisterDiagnose] = diagnose.disposers;
  // Environment (evidence for "what can the film agent load"): preset activation,
  // the ACP child's skill gate, the film tool catalog, and the same instruction
  // chain for the named project. Read-only; rendered on the bundle detail page.
  const environment = createEnvironmentRoute({
    ctx,
    register: registerRoute,
    track: trackRoute,
    skillsDir: fileURLToPath(new URL('../../skills', import.meta.url)),
    filmTools: () => [guideTool, ...filmTools, transcribeTool].map(tool => ({ name: tool?.name, description: tool?.description })),
    instructions: describeInstructions,
    projectPathOf,
    activeTemplatesOf: async path => readActiveTemplates(path),
    authStatus: () => workbenchAuth.status(),
  });
  const [unregisterEnvironment] = environment.disposers;

  // Attachment bytes (validated digest → object store) live in their own module.
  const assets = createAssetRoutes({ ctx, register: registerRoute, track: trackRoute });
  const [unregisterAttachment] = assets.disposers;
  // Page-side events worth keeping when a person reports "it broke": the
  // Panel diagnostics routes (client-log) live in their own module.
  const diagnostics = createDiagnosticsRoutes({ ctx, log, clientEvents: CLIENT_EVENTS, register: registerRoute, track: trackRoute });
  const [unregisterClientLog] = diagnostics.disposers;
  // Bootstrap (auth → Studio up → proxy writes the editor origin) lives in its
  // own module; `origin`, `upstream` and the proxy are live values, so they are
  // passed as getters.
  const bootstrap = createBootstrapRoute({
    ctx,
    register: registerRoute,
    track: trackRoute,
    log,
    origin,
    isDisposed: () => disposed,
    getUpstream: () => upstream,
    ensureStudioStarted: () => runtime.ensureStarted(),
    proxyFor,
  });
  const [unregisterBootstrap] = bootstrap.disposers;
  // The sidebar's "剪辑区" dropdown: every Studio project (a folder), with its
  // editing conversations and the DSH Session the panel happens to be bound to.
  // Read-only and cheap: the project list comes from Studio, the binding from
  // the ACP session store. No Session is created and no model is called.
  // Projects without conversations stay listed: a folder that vanished after
  // its last conversation was deleted could never be deleted from here.
  // Editing routes (sessions/prefs/archive/delete) live in their own module;
  // they are tracked through `track`, so rollbackRoutes() disposes them with the rest.
  createEditingRoutes({
    ctx,
    register: registerRoute,
    track: trackRoute,
    acpSessions: nativeSessions,
    archive,
    archiveBatch: createEditingArchiveBatch({
      file: join(dshFilmDir, 'editing-archive-receipt.json'), bindings: nativeSessions, archive,
      verify: verifyOfficialProject,
      isBusy: row => {
        if (nativeAgentService?.turnState(row.projectId, { conversation: row.conversation ?? '' }).active) return true;
        const agent = ctx.agents?.get?.(row.sessionId);
        return Boolean(agent && (!ctx.agents?.turnBoundaryOf || ctx.agents.turnBoundaryOf(agent.session).openTurnStartSeq != null));
      },
    }),
    editingPrefs,
    verifyOfficialProject,
    listTemplates,
    templatesRoot,
    getLastProxy: () => lastProxy,
    officialStore,
    deleteEditingProject,
    resolveDeleteTarget,
    log,
    getAcpAgentService: () => nativeAgentService,
  });
  diagLogs = createDiagLogsController({
    ctx,
    register: registerRoute,
    track: trackRoute,
    diagLog,
    pluginLog: log,
    preferences,
    runtime,
    agentService,
    pluginVersion: HOST_VERSION,
    openfilmVersion: studioPackageRoot ? (() => { try { return JSON.parse(readFileSync(join(studioPackageRoot, 'package.json'), 'utf8')).version; } catch { return 'unknown'; } })() : 'unknown',
    officialShell,
  });

  if (devAnyFlag) {
    devReady = import('../dev/index.mjs')
      .then((mod) => {
        if (disposed) return null;
        devExtension = mod.createDevExtensions({
          ctx,
          registerRoute,
          trackRoute,
          officialShell,
          isDisposed: () => disposed,
          getUpstream: () => upstream,
          ensureStudioStarted: () => runtime.ensureStarted(),
          proxyFor,
          getBridge: () => debugBridge,
          setBridge: (next) => { debugBridge = next; },
          getPortalUrl: () => browserPortal?.url ?? '',
          listTemplates,
          templatesRoot,
          say: log,
        });
        return devExtension;
      })
      .catch((error) => {
        // Production `.tgz` omits `src/dev/`; missing dev module is expected and safe.
        if (error?.code !== 'ERR_MODULE_NOT_FOUND') {
          log.warn('dev-extension-load-failed', { message: String(error?.message || error).slice(0, 160) });
        }
        return null;
      });
    portalProxyOptions = async () => {
      const ext = await devReady;
      return {
        officialShell,
        log,
        diagLog,
        devHooks: ext?.portalHooks ?? ext?.devHooks ?? { relaxedEmbed: true },
        beforeProjectDelete,
        voiceSettings,
        rewriteLibraryVoices: async () => {
          try {
            const choice = await voiceSettings.prepare();
            if (choice.selected !== 'no996') return null;
            return await voiceBridge.libraryVoicesPayload();
          } catch {
            return { version: 1, providers: [{ id: 'no996', name: '不加班', models: [{ id: 'workbench-tts', name: '不加班配音' }] }], voices: [] };
          }
        },
        ...(officialShell ? { officialRpc, authorizeOfficialProject, attachOfficialEvents, readProjectFile: projectFiles.read, openProjectFile: projectFiles.open } : {}),
      };
    };
  }

  } catch (error) {
    rollbackRoutes();
    throw error;
  }
  // Elevated means Windows will refuse every file drop into this window (UIPI);
  // recording it here turns a mystery "禁止" into one line of evidence.
  log.info('host-start', {
    version: HOST_VERSION, officialShell, editorPort: Number(process.env.NO996_OPENFILM_EDITOR_PORT || 47822),
    elevated: isElevated(),
  });
  // Warm the editor port at assembly. Otherwise the proxy only exists after the
  // first bootstrap, so opening http://<host>:47822 directly (or pasting the
  // address from the docs) reads as a dead port even though the plugin is fine.
  // A failed first attempt is retried: a plugin reload can arrive while the
  // previous Studio child is still releasing its ports, and that failure is
  // instant and transient. Failures stay non-fatal: the panel bootstraps lazily.
  void (async () => {
    const delays = [1000, 3000, 8000];
    for (let attempt = 1; attempt <= delays.length + 1; attempt += 1) {
      const started = Date.now();
      try {
        await runtime.ensureStarted();
        if (!disposed && upstream) await proxyFor(webOrigin);
        log.info('studio-warm', { ms: Date.now() - started, attempt });
        return;
      } catch (error) {
        // A code, never the message: upstream messages may carry keys or paths.
        const code = String(error?.code || 'OTHER');
        log.warn('studio-warm-failed', { code, attempt, message: String(error?.message || error) });
        if (disposed || attempt > delays.length) return;
        await new Promise(resolve => {
          const timer = setTimeout(resolve, delays[attempt - 1]);
          // Never keep the Host process alive just to retry a warm-up.
          if (typeof timer.unref === 'function') timer.unref();
        });
      }
    }
  })();
  return async () => {
    const closingAt = Date.now();
    disposed = true;
    try { disposeVoiceBridge(); } catch { /* already cleared */ }
    // Stop the ACP children before the routes go away: a child that outlives the
    // Host keeps holding the project's Session open.
    try { await nativeAgentService?.close?.(); } catch { /* already closed */ }
    try { devExtension?.dispose?.(); } catch { /* already closed */ }
    rollbackRoutes();
    try { unregisterTranscribe(); } catch { /* already gone */ }
    try { unregisterTranscribeRoute(); } catch { /* already gone */ }
    try { unregisterSystemCheck(); } catch { /* already gone */ }
    try { unregisterSystemInstall(); } catch { /* already gone */ }
    try { unregisterGuide(); } catch { /* already gone */ }
    for (const unregisterTool of unregisterFilmTools) {
      try { unregisterTool(); } catch { /* already removed */ }
    }
    // Stop answering approval questions before the stream that carries them goes
    // away, so nothing is left waiting on a listener that can never reply.
    try { approvals.close(); } catch { /* already closed */ }
    try { archive.close(); } catch { /* already closed */ }
    browserPortal = null;
    const closingDebug = debugBridge;
    debugBridge = undefined;
    closingDebug?.then(bridge => bridge.close()).catch(() => {});
    try { eventHub.close(); } catch { /* already closed */ }
    try { bridgeTrace.close(); } catch { /* already closed */ }
    try { diagLog.close(); } catch { /* already closed */ }
    const perm = await permissionsPromise?.catch?.(() => undefined);
    try { await perm?.close?.(); } catch { /* already closed */ }
    const chat = await officialStorePromise?.catch(() => undefined);
    try { await chat?.close(); }
    finally { await runtime.close(); }
    log.info('host-stop', { uptimeMs: closingAt - openedAt, events: log.count });
    await Promise.all([log.flush().catch(() => {}), diagLog.flush().catch(() => {})]);
  };
}
