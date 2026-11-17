import { createElevationProbe } from '../host/elevation.mjs';
import { createStudioRuntime } from './studio-runtime.mjs';
import { createHostComponentDetector } from '../host/host-components.mjs';
import { installTemplate, listTemplates } from '../official/official-templates.mjs';
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
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// The running Host's own build identity. A plugin reload that re-imports this
// module rewrites the marker; a stale marker proves the process kept old code.
// Read fresh on every evaluation: require() caches JSON, which made this
// report the version from the first load after a hot reload.
const HOST_VERSION = (() => { try { return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version); } catch { return 'unknown'; } })();

const templatesRoot = fileURLToPath(new URL('../../vendor/templates/', import.meta.url));

/** The ACP path is the default; an explicit 0 is the escape hatch. */
/** Page events the Host will record; anything else is refused. */
const CLIENT_EVENTS = new Set(['recovery-shown', 'restart-click', 'picker-placed', 'session-expired', 'permission-shown', 'permission-chosen', 'switch-lost', 'switch-remounted']);
import { redeemStudioSession, startStudioDebug } from './studio-debug.mjs';
import { startLocalConsole } from './studio-debug-redirect.mjs';
import { createDshAskAgent } from '../host/dsh-ai.mjs';
import { reportPresetStatus } from '../host/preset-report.mjs';
import { createGuideTool } from '../tools/guide-tool.mjs';
import { createStoryboardTool } from '../tools/storyboard-tool.mjs';
import { templateCatalog } from '../film/template-catalog.mjs';
import { readActiveTemplates, renderTemplateBlock, syncTemplateBlock, withTemplateBlock, writeActiveTemplates } from '../film/template-prompts.mjs';
import { PERSONA } from '../native/openfilm-persona.mjs';
import { instructionChain } from '../native/instruction-inventory.mjs';
import { createStudioHttp } from './studio-http.mjs';
import { createFrameTool } from '../tools/frame-tool.mjs';
import { createFilmTool } from '../tools/film-tool.mjs';
import { createLibraryTool } from '../tools/library-tool.mjs';
import { createGetTool } from '../tools/get-tool.mjs';
import { createClipTool } from '../tools/clip-tool.mjs';
import { createAssetsTool } from '../tools/assets-tool.mjs';
import { createExportTool } from '../tools/export-tool.mjs';
import { createCliTool } from '../tools/cli-tool.mjs';
import { createTranscribeTool } from '../tools/transcribe-tool.mjs';
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
import { createVoiceBridge, installVoiceBridgeGlobal } from '../voice/voice-bridge.mjs';
import { installNo996Provider, preferNo996ForTts } from '../voice/install-no996-provider.mjs';
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
import { createDebugUrlRoute } from './studio-controller/routes/debug-url.mjs';
import { createDiagnoseRoute } from './studio-controller/routes/diagnose.mjs';
import { createEnvironmentRoute } from './studio-controller/routes/environment.mjs';
import { createDiagnosticsRoutes } from './studio-controller/routes/diagnostics.mjs';
import { createEditingRoutes } from './studio-controller/routes/editing.mjs';
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

export function createStudioController(ctx, createProxy, { officialShell = false } = {}) {
  const log = createPluginLog();
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
  const workbenchAuth = createWorkbenchAuth({ dev: process.env.NO996_OPENFILM_DEV === '1' });
  const voiceBridge = createVoiceBridge({ auth: workbenchAuth });
  const disposeVoiceBridge = installVoiceBridgeGlobal(voiceBridge);
  void voiceBridge.refreshReady().then((ready) => {
    log.info('no996-voice-ready', { ready });
  }).catch((error) => {
    log.warn('no996-voice-ready', { message: String(error?.message || error).slice(0, 200) });
  });
  void installNo996Provider().then(async (info) => {
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
    return preferNo996ForTts({ force: true });
  }).then((pref) => {
    if (pref?.changed) log.info('no996-tts-preferred', pref);
  }).catch((error) => {
    log.warn('no996-provider-install', { message: String(error?.message || error).slice(0, 200) });
  });
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
  void writeFile(join(tmpdir(), 'dsh-openfilm-host.json'), JSON.stringify({
    version: HOST_VERSION,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    injected: true,
  }, null, 1), 'utf8').catch(() => { /* diagnostics only */ });
  presetReport.done.catch(() => {});
  // A stable address the person can type into the right-side browser without
  // opening the panel first. That browser does not share DSH's cookie, so DSH
  // routes answer 401 there; this listener serves the template console itself and
  // does the Studio work in the Host. Disable with NO996_OPENFILM_DEBUG_PORT=0.
  if (process.env.NO996_OPENFILM_DEBUG_PORT !== '0') {
    debugBridge = startLocalConsole({
      templates: () => listTemplates(templatesRoot),
      // The right-side browser has no DSH cookie, so /editor hands it a one-use
      // ticket instead of a cookie-gated URL. Minted in-process, never logged.
      // Desktop panel asks this before any Host bootstrap. Warm the Studio and
      // mint a ticket here — returning null just because warm finished late is
      // what produced `HTTP 503 @ dsh-app://app (console)` after login.
      editorUrl: async () => {
        if (disposed) return null;
        try {
          await runtime.ensureStarted();
          if (disposed || !upstream) return null;
          const proxy = await proxyFor(webOrigin);
          return proxy?.issueTicket?.()?.url ?? null;
        } catch { return null; }
      },
      // Desktop panel (`dsh-app://app`) cannot reach Host /api routes; auth goes
      // through this loopback console. Tokens stay on the Host.
      authHandler: async raw => {
        if (disposed) return { status: 503, body: { error: 'UNAVAILABLE' } };
        try {
          const value = parseAuthActionBody(raw);
          const result = await dispatchAuthAction(workbenchAuth, value);
          void voiceBridge.refreshReady().catch(() => {});
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
    });
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
  const projectParentDir = async (proxy) => {
    const projects = await proxy.listProjects().catch(() => []);
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
  const createBlankOfficialProject = async (proxy) => {
    const parentDir = await projectParentDir(proxy);
    await mkdir(parentDir, { recursive: true });
    const target = join(parentDir, `自定义-${randomBytes(3).toString('hex')}`);
    await mkdir(target);
    const project = await proxy.createProject(target);
    if (!project || typeof project.id !== 'string' || typeof project.path !== 'string') {
      throw Object.assign(new Error('Studio returned an invalid project'), { code: 'TEMPLATE_REGISTRATION_UNCERTAIN' });
    }
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
  const officialRpc = async (channel, payload) => {
    if (disposed) throw new Error('Studio disposed');
    if (channel === 'agent:prompt') {
      if (!agentService) throw new Error('Agent bridge unavailable');
      // The conversation is what the page's chat is: without it the Host would send
      // every project's turns into one DSH Session (the "new chat continues the old
      // one" bug). '' is the project's default conversation.
      const conversation = typeof payload?.conversation === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(payload.conversation) ? payload.conversation : '';
      return agentService.send(payload?.projectId, { conversation, key: payload?.key, turnId: payload?.turnId, text: payload?.text, images: payload?.images });
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
      const proxy = await lastProxy;
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
      if (channel === 'auth:logout') {
        // A dev session has nothing to log out of; clearing it would only bounce
        // the person back to a gate that accepts nothing.
        if (workbenchAuth.dev) return { loggedIn: true, dev: true };
        await workbenchAuth.logout();
        await preferences.set(clearBalanceCachePatch());
        void voiceBridge.refreshReady().catch(() => {});
        return { loggedIn: false };
      }
      if (workbenchAuth.dev) return { ok: true, dev: true };
      const action = payload && typeof payload === 'object' ? payload : {};
      try {
        const result = await dispatchAuthAction(workbenchAuth, action);
        void voiceBridge.refreshReady().catch(() => {});
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
      const proxy = await lastProxy;
      if (!proxy || typeof proxy.createProject !== 'function') throw Object.assign(new Error('Studio is not ready'), { code: 'TEMPLATE_UNAVAILABLE' });
      const templateId = channel === 'project:create-blank' ? 'custom' : payload?.templateId;
      if (templateId === 'custom') {
        const presets = payload && typeof payload === 'object'
          ? { ratio: payload.ratio, seconds: payload.seconds, language: payload.language }
          : undefined;
        return finishOnboardingProject('custom', await createBlankOfficialProject(proxy), presets);
      }
      const chosen = (await listTemplates(templatesRoot)).find(item => item.id === templateId);
      if (!chosen) throw Object.assign(new Error('Unknown template'), { code: 'TEMPLATE_INPUT' });
      // New films live beside the user's existing ones; with no project yet, a
      // folder under the home directory keeps the same one-project-one-folder shape.
      const parentDir = await projectParentDir(proxy);
      const created = await installTemplate({
        root: templatesRoot,
        id: chosen.id,
        parentDir,
        createProject: target => proxy.createProject(target),
        titleFor: () => chosen.title,
      });
      // Record the template the film was made from. Its prompt is rendered into the
      // project's AGENTS.md on the next prepare (never here: writing AGENTS.md before
      // the base protocol exists would make the base look "already present").
      try { writeActiveTemplates(created.path, [chosen.id]); } catch { /* the film still works */ }
      return { ...(await finishOnboardingProject(chosen.id, created)), prompt: chosen.prompt };
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
  if (chatTrace.enabled) void log.info('chat-trace', { enabled: true, dir: tmpdir() + '\\dsh-openfilm\\trace' });
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
    try {
      const active = readActiveTemplates(projectPath);
      if (active.length > 0) {
        const catalog = await templateCatalog(templatesRoot);
        const chosen = active.map(id => catalog.find(item => item.id === id)).filter(Boolean);
        const synced = syncTemplateBlock(projectPath, chosen);
        if (synced.changed) void log.info('project-templates-synced', { projectId, count: chosen.length });
      }
    } catch { /* templates are a convenience: the base protocol still applies */ }
  };

  nativeAgentService = createDshNativeAgentService({
    ctx,
    verifier: verifyOfficialProject,
    store: nativeSessions,
    emit: async (projectId, event) => deliverToPanel(projectId, event),
    prepareProject: prepareProjectInstructions,
    defaultSelection: () => {
      try {
        const current = ctx.agentDefaultModel?.currentSelection?.();
        if (current && (current.provider || current.model)) return current;
      } catch { /* ignore */ }
      return undefined;
    },
    log: (event, fields) => void log.info(event, fields),
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
  // Studio shows its own "what's new" dialog once after every version bump, which
  // for a bundled Studio means every time this plugin upgrades. The dialog is
  // gated by `prefs.seenVersion` (components/WhatsNew.tsx: it shows only when the
  // saved version is older than the running one), so keeping that value ahead of
  // any release retires the dialog without touching the page.
  const WHATS_NEW_SEEN = '9999.0.0';
  let whatsNewSettled = false;
  const suppressWhatsNew = async () => {
    if (whatsNewSettled || disposed) return;
    try {
      const client = studioHttp();
      const prefs = await client.get('/api/prefs');
      if (!prefs || typeof prefs !== 'object') return;
      whatsNewSettled = true;
      if (prefs.seenVersion === WHATS_NEW_SEEN) return;
      await client.patch('/api/prefs', { body: { seenVersion: WHATS_NEW_SEEN } });
      log.info('whats-new-suppressed', { from: typeof prefs.seenVersion === 'string' ? prefs.seenVersion : null });
    } catch { /* prefs are a convenience: the dialog is not worth failing a turn over */ }
  };
  // The project an agent may edit, resolved from the Host's own record. Never from
  // a renderer-supplied id.
  const projectOfAgent = agent => {
    const native = nativeAgentService?.projectOfAgent?.(agent);
    return native ? { projectId: native.projectId, path: native.path, available: true } : undefined;
  };
  const filmTools = [
    createFrameTool({ isProjectAgent, projectOf: projectOfAgent, http: studioHttp, attachments: () => ctx.get('attachments'), llm: () => ctx.llm }),
    createFilmTool({ isProjectAgent, projectOf: projectOfAgent, http: studioHttp }),
    createLibraryTool({
      isProjectAgent,
      projectOf: projectOfAgent,
      http: studioHttp,
      templates: () => templateCatalog(templatesRoot),
      // Choosing a template persists the choice and renders its prompt into the
      // project's AGENTS.md: a template is a point of view, not just a starting file
      // (src/template-prompts.mjs). Several may be active; order is the join order.
      activateTemplate: async (projectPath, id) => {
        const catalog = await templateCatalog(templatesRoot);
        const active = readActiveTemplates(projectPath);
        const next = active.includes(id) ? active : [...active, id];
        writeActiveTemplates(projectPath, next);
        const chosen = next.map(templateId => catalog.find(item => item.id === templateId)).filter(Boolean);
        syncTemplateBlock(projectPath, chosen);
        return { active: next, templates: chosen };
      },
    }),
    // Plan before cutting: the storyboard is the contract the timeline follows, and
    // "from-script" turns a transcript into shots on sentence boundaries.
    createStoryboardTool({ isProjectAgent, projectOf: projectOfAgent }),
    createGetTool({ isProjectAgent, projectOf: projectOfAgent, http: studioHttp }),
    createClipTool({ isProjectAgent, projectOf: projectOfAgent }),
    createAssetsTool({ isProjectAgent, projectOf: projectOfAgent, http: studioHttp }),
    createExportTool({ isProjectAgent, projectOf: projectOfAgent, http: studioHttp }),
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
  const runtime = createStudioRuntime({ askAgent, ...(officialShell ? { resolveEditorDir: resolveOfficialShell } : {}), attach: async studio => {
    upstream = studio;
    return async () => {
      upstream = undefined;
      const pending = [...proxies.values()];
      proxies.clear();
      const settled = await Promise.allSettled(pending);
      await Promise.all(settled.filter(item => item.status === 'fulfilled').map(item => item.value.close()));
    };
  } });
  const attachOfficialEvents = ({ projectId, res }) => {
    if (disposed) { res.destroy(); return; }
    attachOfficialEventStream({ hub: eventHub, projectId, response: res });
  };
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
    const pending = Promise.resolve().then(() => createProxy({
      upstream,
      webOrigin: browserOrigin,
      authenticateBrowser,
      desktop,
      officialShell,
      log,
      beforeProjectDelete,
      rewriteLibraryVoices: async () => {
        try {
          await voiceBridge.refreshReady();
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
      return next;
    });
    proxies.set(browserOrigin, pending);
    lastProxy = pending;
    pending.catch(() => { if (proxies.get(browserOrigin) === pending) proxies.delete(browserOrigin); });
    return pending;
  }
  let unregisterTemplateBridge;
  let unregisterAuthBridge;
  let unregisterArchiveBridge;
  let unregisterAttachment;
  let unregisterClientLog;
  let unregisterStandalone;
  let unregisterTemplatesPage;
  try {
  unregisterTemplateBridge = trackRoute(registerTemplateBridge(ctx, {
    webOrigin,
    list: () => listTemplates(templatesRoot),
    create: templateId => officialRpc('template:create', { templateId }),
    isDisposed: () => disposed,
  }));
  unregisterAuthBridge = trackRoute(registerAuthBridge(ctx, {
    webOrigin,
    auth: workbenchAuth,
    isDisposed: () => disposed,
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
  unregisterStandalone = trackRoute(registerRoute({
    kind: 'exact', path: '/no996-openfilm/standalone',
    async handler(req, res) {
      // A plain browser window for layout work. Same DSH origin, so it uses the
      // same authenticated session; it opens no new listener and shares no key.
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return; }
      const admission = ctx.connection.admit({ headers: req.headers });
      if ('rejection' in admission) { res.writeHead(admission.rejection).end('DSH_SESSION_REQUIRED'); return; }
      const page = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenFilm 视频创作</title>'
        + '<style>html,body{margin:0;height:100%;background:#111;color:#eee;font:13px system-ui,sans-serif}'
        + '#bar{display:flex;gap:12px;align-items:center;padding:6px 10px;border-bottom:1px solid #333}'
        + '#bar label{display:flex;gap:6px;align-items:center}#frame{display:block;width:100%;height:calc(100% - 37px);border:0;background:#000}'
        + '#err{padding:16px;color:#f88;white-space:pre-wrap}</style></head><body>'
        + '<div id="bar"><strong>OpenFilm 视频创作</strong>'
        + '<label>对话侧 <select id="side"><option value="right">右侧</option><option value="left">左侧</option></select></label>'
        + '<label>宽度 <input id="width" type="range" min="240" max="800" step="20" value="420"><span id="wv">420</span></label>'
        + '<button id="reload">重新载入</button><span id="status">正在启动…</span></div>'
        + '<iframe id="frame" allow="clipboard-read; clipboard-write"></iframe><pre id="err" hidden></pre>'
        + '<script>(function(){var f=document.getElementById("frame"),status=document.getElementById("status"),err=document.getElementById("err");'
        + 'var side=document.getElementById("side"),width=document.getElementById("width"),wv=document.getElementById("wv");'
        + 'function post(){var w=Number(width.value);wv.textContent=w;try{f.contentWindow.postMessage({type:"no996-openfilm:layout",version:1,side:side.value,width:w},"*")}catch(e){}}'
        + 'function fail(m){err.hidden=false;err.textContent=String(m);status.textContent="启动失败"}'
        + 'function start(){status.textContent="正在启动…";fetch("/api/no996-openfilm/bootstrap",{method:"POST",credentials:"same-origin"})'
        + '.then(function(r){if(!r.ok)throw new Error("bootstrap HTTP "+r.status);return r.json()})'
        + '.then(function(d){var u=new URL(d.editorOrigin);f.src=u.origin+"/";status.textContent="已连接 "+u.origin;f.onload=post})'
        + '.catch(function(e){fail(e&&e.message||e)})}'
        + 'side.onchange=post;width.oninput=post;document.getElementById("reload").onclick=function(){err.hidden=true;start()};start();})();</script>'
        + '</body></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(page) }).end(page);
    },
  }));
  unregisterTemplatesPage = trackRoute(registerRoute({
    kind: 'exact', path: '/no996-openfilm/templates',
    async handler(req, res) {
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return; }
      const admission = ctx.connection.admit({ headers: req.headers });
      if ('rejection' in admission) { res.writeHead(admission.rejection).end(); return; }
      if (admission.peer.id !== ctx.connection.browserPeer.id) { res.writeHead(403).end('DSH_BROWSER_REQUIRED'); return; }
      let items = [];
      try { items = await listTemplates(templatesRoot); } catch { /* an empty page still explains itself */ }
      const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
      const cards = items.map(item => `<li><strong>${escape(item.title)}</strong> <small>${escape(item.mode)}</small><p>${escape(item.description)}</p><button type=\"button\" data-id=\"${escape(item.id)}\">用这个模板建项目</button></li>`).join('');
      const html = `<!doctype html><meta charset=\"utf-8\"><title>OpenFilm 模板</title><style>body{font:14px system-ui,sans-serif;background:#171717;color:#e8e8e8;margin:24px}li{margin:16px 0;padding:12px;border:1px solid #333;border-radius:8px;list-style:none}button{margin-top:8px;padding:6px 12px;border-radius:6px;border:1px solid #555;background:#2a2a2a;color:inherit;cursor:pointer}p{margin:6px 0;opacity:.8}#msg{margin-top:16px;color:#f88}</style><h1>OpenFilm 模板</h1><ul>${cards || '<li>没有可用模板</li>'}</ul><div id=\"msg\"></div><script>document.addEventListener('click',async e=>{const b=e.target.closest('button[data-id]');if(!b)return;b.disabled=true;b.textContent='创建中…';try{const r=await fetch('/__dsh/official-rpc',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({channel:'template:create',payload:{templateId:b.dataset.id}})});const d=await r.json();if(!d||!d.projectId)throw new Error((d&&d.error)||('HTTP '+r.status));if(d.prompt){try{localStorage.setItem('no996.openfilm.templatePrompt',d.prompt)}catch(_){}}location.href='/projects/'+d.projectId}catch(err){document.getElementById('msg').textContent='创建失败：'+(err&&err.message||err);b.disabled=false;b.textContent='用这个模板建项目'}})</script>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) }).end(html);
    },
  }));
  // Debug window URL (cookie lives in the debug listener, not the browser).
  const debugUrl = createDebugUrlRoute({
    ctx,
    register: registerRoute,
    track: trackRoute,
    officialShell,
    isDisposed: () => disposed,
    getUpstream: () => upstream,
    ensureStudioStarted: () => runtime.ensureStarted(),
    proxyFor,
    getBridge: () => debugBridge,
    setBridge: (next) => { debugBridge = next; },
  });
  const [unregisterDebugUrl] = debugUrl.disposers;

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
        void suppressWhatsNew();
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
    const closingDebug = debugBridge;
    debugBridge = undefined;
    closingDebug?.then(bridge => bridge.close()).catch(() => {});
    try { eventHub.close(); } catch { /* already closed */ }
    try { bridgeTrace.close(); } catch { /* already closed */ }
    const chat = await officialStorePromise?.catch(() => undefined);
    try { await chat?.close(); }
    finally { await runtime.close(); }
    log.info('host-stop', { uptimeMs: closingAt - openedAt, events: log.count });
    await log.flush().catch(() => {});
  };
}
