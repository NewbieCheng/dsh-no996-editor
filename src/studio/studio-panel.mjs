/** The video panel: the official OpenFilm desktop shell, full width.
 *
 * The official shell carries its own Studio, its own chat column and its own
 * resizer, so this panel renders nothing beside it. Templates are offered from
 * inside that shell (injected picker) instead of a separate home page: one
 * surface, no "choose a template" detour before the editor.
 *
 * Workbench login lives inside the official shell (`assets/shell-login.js`),
 * not as a separate panel page. This panel always boots Studio; the shell
 * overlays a compact gate until Host auth is ready. Tokens never reach here.
 */


import { areaBus } from '../host/area-bus.mjs';
import { studioFailureSummary } from './panel-failure.mjs';

/** Shared project-URL guard. The injected template picker and the standalone
 * templates page both build `/projects/<id>`, so the rule lives in one place. */
export function templateProjectUrl(editorOrigin, projectId) {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) throw new Error('Invalid project');
  return `${new URL(editorOrigin).origin}/projects/${projectId}`;
}

export function createStudioPanel(React) {
  const h = React.createElement;
  return function StudioPanel({ t, startStudio }) {
    const HOST_HTTP = typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol);
    const [state, setState] = React.useState({ status: 'idle' });
    const [attempt, setAttempt] = React.useState(0);
    const [silent, setSilent] = React.useState(false);
    const [preset, setPreset] = React.useState(null);
    // Archive state of the project whose editor is open. It is read from the
    // Host, which owns DSH's durable archive set; this panel keeps no copy.
    const [projectId, setProjectId] = React.useState(null);
    const [archive, setArchive] = React.useState(null);
    const [archiveBusy, setArchiveBusy] = React.useState(false);
    // The official shell can keep painting after Studio dies. Watch the Host
    // and silently re-bootstrap — no stopped card.
    const autoRetriedRef = React.useRef(false);
    const iframeRef = React.useRef(null);
    const heardRef = React.useRef(false);
    const watchNavigationRef = React.useRef(null);
    const readyRef = React.useRef(false);
    const urlRef = React.useRef(null);
    // One renewal is in flight at a time; the frame answers with whether the
    // cookie was extended.
    const renewAckRef = React.useRef(null);

    const reportPanelDiag = (payload) => {
      if (!HOST_HTTP) return;
      try {
        void fetch('/api/no996-openfilm/client-diag', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
      } catch { /* ignore */ }
    };

    // Ask the official shell to show one project (and optionally select a conversation).
    // The injected bridge owns the history call and session selection event; this side
    // only has to reach a frame that is really loaded.
    const postNavigate = (target, sessionId) => {
      const projectId = typeof target === 'string' ? target : target?.projectId;
      const sid = typeof sessionId === 'string' ? sessionId : (typeof target === 'object' ? target?.sessionId : undefined);
      const frame = iframeRef.current;
      if (!frame || !frame.contentWindow || !readyRef.current || typeof projectId !== 'string') return false;
      let origin = '*';
      try { origin = new URL(urlRef.current).origin; } catch { /* keep the wildcard */ }
      try {
        frame.contentWindow.postMessage({
          type: 'no996-openfilm:navigate',
          version: 1,
          projectId,
          ...(typeof sid === 'string' && sid ? { sessionId: sid } : {}),
        }, origin);
        return true;
      } catch { return false; }
    };

    React.useEffect(() => {
      const off = areaBus.subscribe(event => {
        if (event.type === 'navigate') postNavigate(event.projectId, event.sessionId);
      });
      return off;
    }, []);

    React.useEffect(() => {
      // A custom-scheme page (dsh-app://app) cannot reach /api/... at all; the
      // app protocol handler answers 404. Skip instead of logging noise.
      if (!HOST_HTTP) return undefined;
      let live = true;
      // Read the Host's own view of the video preset so a silent activation
      // failure is visible here instead of surfacing later as a broken chat.
      fetch('/api/no996-openfilm/diagnose', { method: 'POST', credentials: 'same-origin' })
        .then(response => (response.ok ? response.json() : null))
        .then(data => { if (live && data?.preset) setPreset(data.preset); })
        .catch(() => {});
      return () => { live = false; };
    }, [HOST_HTTP]);

    React.useEffect(() => {
      const controller = new AbortController();
      setState({ status: 'loading' });
      heardRef.current = false;
      // A plugin reload removes the route for a moment; a request landing in that
      // gap returns 404, and the panel used to keep that error until someone
      // pressed 重试. Two quiet retries cover the gap without hiding real faults.
      // Desktop console can 503 while Studio is still warming; give it a few
      // quiet retries before surfacing the error (AGENTS §10).
      const attemptOnce = retries => Promise.resolve()
        .then(() => startStudio(controller.signal))
        .catch(async error => {
          const transient = /HTTP (404|503)\b/.test(String(error?.message || error));
          if (transient && retries > 0 && !controller.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 1500));
            if (controller.signal.aborted) throw error;
            return attemptOnce(retries - 1);
          }
          throw error;
        });
      attemptOnce(4).then(result => {
        if (controller.signal.aborted) return;
        const target = new URL(result.editorOrigin);
        const desktop = window.location.hostname === 'app' && ['dsh-app:', 'app:'].includes(window.location.protocol);
        const hostAllowed = desktop ? ['127.0.0.1', '127.0.0.2'].includes(target.hostname) : ['127.0.0.1', 'localhost'].includes(target.hostname) && target.hostname === window.location.hostname;
        if (target.protocol !== 'http:' || !hostAllowed || !target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
          throw new Error(`Invalid local Studio address (${window.location.hostname || 'none'} → ${target.hostname || 'none'})`);
        }
        if (desktop && (typeof result.ticket !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(result.ticket))) throw new Error('Invalid Studio desktop ticket');
        const url = desktop ? `${target.origin}/__dsh/open#${result.ticket}` : `${target.origin}/`;
        setState({
          status: 'ready', url,
          webOrigin: typeof result.webOrigin === 'string' ? result.webOrigin : '',
          // How long the frame's own credential lasts. Zero means this surface
          // authenticates with DSH's cookie and there is nothing to renew.
          sessionExpiresIn: desktop && Number.isFinite(result.sessionExpiresIn) && result.sessionExpiresIn > 0
            ? Math.round(result.sessionExpiresIn) : 0,
        });
      }).catch(error => {
        if (!controller.signal.aborted) {
          const message = String(error?.message || error);
          reportPanelDiag({ level: 'error', layer: 'ui', code: 'PANEL_BOOTSTRAP_FAILED', location: 'src/studio/studio-panel.mjs:startStudio', summary: `面板启动 Studio 失败: ${message.slice(0, 200)}`, detail: { message } });
          setState({ status: 'error', message, code: error?.code, httpStatus: error?.httpStatus });
        }
      });
      return () => controller.abort();
    }, [attempt, startStudio]);

    React.useEffect(() => {
      if (state.status !== 'ready') return undefined;
      const editorOrigin = new URL(state.url).origin;
      urlRef.current = state.url;
      readyRef.current = false;
      let timer;
      const watchNavigation = () => {
        heardRef.current = false;
        setSilent(false);
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!heardRef.current) {
            reportPanelDiag({ level: 'error', layer: 'ui', code: 'IFRAME_SILENT_TIMEOUT', location: 'src/studio/studio-panel.mjs:watchNavigation', summary: '工作台 iframe 20 秒未收到 boot 信号' });
            setSilent(true);
          }
        }, 20000);
      };
      watchNavigationRef.current = watchNavigation;
      watchNavigation();
      const receive = event => {
        if (event.origin !== editorOrigin || event.source !== iframeRef.current?.contentWindow) return;
        const data = event.data;
        if (data && typeof data === 'object' && data.type === 'no996-openfilm:boot' && data.version === 1) {
          if (data.rendered === true) {
            heardRef.current = true;
            readyRef.current = true;
            setSilent(false);
            clearTimeout(timer);
            // The frame can act on a navigation request now; a click made while the
            // panel was still booting is flushed here instead of being dropped.
            areaBus.reportReady();
            const pending = typeof areaBus.takePendingTarget === 'function' ? areaBus.takePendingTarget() : areaBus.takePending();
            if (pending) postNavigate(pending);
          }
        }
        if (data && typeof data === 'object' && data.type === 'no996-openfilm:restart' && data.version === 1) {
          setSilent(false);
          setAttempt(value => value + 1);
        }
        if (data && typeof data === 'object' && data.type === 'no996-openfilm:renewed' && data.version === 1) {
          const acknowledge = renewAckRef.current;
          renewAckRef.current = null;
          if (acknowledge) acknowledge(data.ok === true);
        }
        // Login/logout are handled inside the official shell overlay. Keep the
        // iframe up so logout only reopens the compact gate, never tears Studio down.
        if (data && typeof data === 'object' && data.type === 'no996-openfilm:archive' && data.version === 1 && typeof data.projectId === 'string') {
          // The Studio shell reports the archive state over the same channel it
          // uses for the project, so this works on the desktop scheme too (where
          // the relative Host /api route is unreachable).
          setArchive({ available: data.available !== false, archived: data.archived === true });
        }
        if (data && typeof data === 'object' && data.type === 'no996-openfilm:project' && data.version === 1 && typeof data.projectId === 'string') {
          // The project area draws the same projects and follows the one on screen.
          areaBus.reportProject(/^[A-Za-z0-9_-]{6,40}$/.test(data.projectId) ? data.projectId : null);
          try {
            if (/^[A-Za-z0-9_-]{6,40}$/.test(data.projectId)) {
              localStorage.setItem('no996.openfilm.lastProject', data.projectId);
              setProjectId(data.projectId);
            } else {
              localStorage.removeItem('no996.openfilm.lastProject');
              setProjectId(null);
            }
          } catch { /* private mode */ }
        }
      };
      window.addEventListener('message', receive);
      // A frame that never boots cannot report its own failure; surface silence.

      return () => {
        clearTimeout(timer);
        watchNavigationRef.current = null;
        window.removeEventListener('message', receive);
      };
    }, [state.status, state.url, attempt]);

    const retry = () => { setSilent(false); setAttempt(value => value + 1); };
    // A desktop frame authenticates with the proxy's own session cookie, and that
    // cookie lapses. Reloading the frame to refresh it (what this panel used to do
    // after the credential expired) throws away unsaved edits and every live
    // connection, and reads to the person as "the editor keeps disconnecting".
    // Instead, ask the Host for a fresh one-use grant before the deadline and hand
    // it to the frame that is already open, which redeems it in place.
    React.useEffect(() => {
      if (state.status !== 'ready' || !(state.sessionExpiresIn > 0)) return undefined;
      let frameOrigin;
      try { frameOrigin = new URL(state.url).origin; } catch { return undefined; }
      const lifetimeMs = state.sessionExpiresIn * 1000;
      // Keep a fifth of the lifetime (at most five minutes, never more than half)
      // as the safety margin; a long-lived editor renews well before it can be
      // refused, and a short-lived one never schedules itself in the past.
      const leadFor = lifetime => Math.min(300000, Math.max(1000, Math.round(lifetime * 0.2)), Math.floor(lifetime / 2));
      let live = true;
      let timer = 0;
      let failures = 0;
      let due = Date.now() + lifetimeMs - leadFor(lifetimeMs);
      const schedule = delay => { clearTimeout(timer); timer = setTimeout(() => { void cycle(); }, Math.max(0, delay)); };
      const cycle = async () => {
        if (!live) return;
        const frame = iframeRef.current;
        if (!frame || !frame.contentWindow) { schedule(15000); return; }
        let grant;
        try {
          const response = await fetch('/api/no996-openfilm/renew-session', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json', 'x-no996-surface': `${window.location.protocol}//${window.location.host}` },
            body: '{}',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          grant = await response.json();
          if (!grant || typeof grant.ticket !== 'string') throw new Error('Invalid renewal grant');
        } catch {
          failures += 1;
          if (live && failures <= 5) schedule(Math.min(30000, 2000 * failures));
          return;
        }
        if (!live) return;
        const acknowledged = new Promise(resolve => {
          renewAckRef.current = resolve;
          // A frame that never answers is not renewed; try again instead of
          // waiting for the credential to lapse.
          setTimeout(() => {
            if (renewAckRef.current !== resolve) return;
            renewAckRef.current = null;
            resolve(false);
          }, 10000);
        });
        try {
          frame.contentWindow.postMessage({ type: 'no996-openfilm:renew-session', version: 1, ticket: grant.ticket }, frameOrigin);
        } catch { /* frame went away; the retry below covers it */ }
        const ok = await acknowledged;
        if (!live) return;
        if (!ok) {
          failures += 1;
          if (failures <= 5) schedule(Math.min(30000, 2000 * failures));
          return;
        }
        failures = 0;
        const next = Number.isFinite(grant.sessionExpiresIn) && grant.sessionExpiresIn > 0 ? grant.sessionExpiresIn * 1000 : lifetimeMs;
        due = Date.now() + next - leadFor(next);
        schedule(due - Date.now());
      };
      // A suspended laptop can wake up past the deadline; renew then instead of
      // waiting for another whole period.
      const wake = () => { if (live && Date.now() >= due) { clearTimeout(timer); void cycle(); } };
      const doc = typeof document !== 'undefined' ? document : null;
      if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', wake);
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('focus', wake);
      schedule(due - Date.now());
      return () => {
        live = false;
        clearTimeout(timer);
        if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', wake);
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('focus', wake);
        const acknowledge = renewAckRef.current;
        renewAckRef.current = null;
        if (acknowledge) acknowledge(false);
      };
    }, [state.status, state.url, state.sessionExpiresIn]);
    // Poll the Host's Studio state while the panel is up. On outage: silent
    // re-bootstrap with backoff — no "stopped" card, no copy asking anyone to
    // quit OpenFilm. Keep retrying until health recovers or the panel unmounts.
    React.useEffect(() => {
      if (!HOST_HTTP || state.status !== 'ready') return undefined;
      let live = true;
      let misses = 0;
      let backoffMs = 2000;
      let retryTimer = 0;
      const check = async () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        let running = false;
        try {
          const response = await fetch('/api/no996-openfilm/diagnose', { method: 'POST', credentials: 'same-origin' });
          const data = response.ok ? await response.json() : null;
          running = data?.studio?.running === true;
        } catch { /* the Host itself may be reloading */ }
        if (!live) return;
        if (running) {
          misses = 0;
          backoffMs = 2000;
          autoRetriedRef.current = false;
          return;
        }
        misses += 1;
        if (misses < 2 || autoRetriedRef.current) return;
        autoRetriedRef.current = true;
        setSilent(false);
        setAttempt(value => value + 1);
        const wait = backoffMs;
        backoffMs = Math.min(15000, Math.round(backoffMs * 1.8));
        retryTimer = setTimeout(() => { if (live) autoRetriedRef.current = false; }, wait);
      };
      check();
      const timer = setInterval(check, 5000);
      return () => { live = false; clearInterval(timer); clearTimeout(retryTimer); };
    }, [state.status, attempt]);
    // Archive polling: archiving in the DSH sidebar has no channel into this
    // frame, and a stalled send is the symptom we are removing.
    React.useEffect(() => {
      if (!HOST_HTTP || !projectId || state.status !== 'ready') { setArchive(null); return undefined; }
      let live = true;
      const read = async () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        try {
          const response = await fetch('/api/no996-openfilm/archive', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'state', projectId }),
          });
          const data = await response.json().catch(() => null);
          if (live && response.ok && data) setArchive({ available: data.available !== false, archived: data.archived === true });
        } catch { /* keep the last known state; the banner is not a source of truth */ }
      };
      read();
      const timer = setInterval(read, 15000);
      return () => { live = false; clearInterval(timer); };
    }, [projectId, state.status]);
    const changeArchive = async action => {
      if (!projectId || archiveBusy) return;
      setArchiveBusy(true);
      try {
        const response = await fetch('/api/no996-openfilm/archive', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, projectId }),
        });
        const data = await response.json().catch(() => null);
        if (response.ok && data) setArchive({ available: data.available !== false, archived: data.archived === true });
      } catch { /* the next poll reconciles */ }
      finally { setArchiveBusy(false); }
    };

    const [copyStatus, setCopyStatus] = React.useState('');
    const failureCard = (code, httpStatus) => {
      const summary = studioFailureSummary({ code, httpStatus, attempt });
      return h('section', { style: { padding: 24, maxWidth: 640, color: 'var(--dsw-alias-label-primary)' } },
        h('h2', { role: 'alert', style: { fontSize: 18 } }, t('studioFailed')),
        h('p', null, t(code === 'IFRAME_SILENT_TIMEOUT' ? 'studioSilentHint' : code === 'OFFICIAL_SHELL_UNAVAILABLE' ? 'studioShellMismatch' : 'studioFailureHint')),
        h('p', null, t('studioRestartHint')),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12 } },
          h('button', { type: 'button', onClick: () => { setCopyStatus(''); retry(); } }, t('studioRetry')),
          h('button', { type: 'button', onClick: async () => {
            try { await navigator.clipboard.writeText(summary); setCopyStatus('studioCopied'); }
            catch { setCopyStatus('studioCopyFallback'); }
          } }, t('studioCopyDiagnostic'))),
        copyStatus ? h('p', { role: 'status' }, t(copyStatus)) : null,
        h('details', { open: copyStatus === 'studioCopyFallback' || undefined },
          h('summary', null, t('studioFailureDetails')),
          h('pre', { style: { whiteSpace: 'pre-wrap', userSelect: 'text' } }, summary),
          h('a', { href: 'https://github.com/NewbieCheng/dsh-no996-editor/issues', target: '_blank', rel: 'noreferrer' }, t('studioContact'))));
    };
    let studio;
    const archived = archive?.available !== false && archive?.archived === true;
    if (state.status === 'loading' || state.status === 'idle') {
      studio = h('div', { role: 'status', style: { padding: 24, color: 'var(--dsw-alias-label-secondary)' } },
        t('studioLoading'),
        preset && !preset.ok ? h('p', { style: { margin: '8px 0 0', fontSize: 12, opacity: 0.8 } }, `${t('presetMissing')} ${String(preset.detail || '').slice(0, 120)}`) : null);
    } else if (state.status === 'error') {
      studio = failureCard(state.code || 'PANEL_BOOTSTRAP_FAILED', state.httpStatus ?? Number(/\bHTTP ([45]\d\d)\b/.exec(state.message)?.[1]));
    } else {
      studio = h('iframe', {
        ref: iframeRef, title: t('studioTitle'), src: state.url,
        onLoad: () => {
          // The DSH page catches drops the frame cannot see; it needs the frame.
          try {
            window.__no996ShellFrame = iframeRef.current?.contentWindow ?? null;
            window.__no996ShellFrameElement = iframeRef.current ?? null;
          } catch { /* gone */ }
          watchNavigationRef.current?.();
        },
        // No `sandbox` attribute: Chromium refuses file drops from the desktop
        // into a sandboxed frame (the cursor stays at "no entry" and the page gets
        // no dragover at all), which broke dropping a video onto the chat. The
        // shell page is our own vendored UI on a validated loopback origin, not
        // untrusted content — the check that matters is the URL guard below, and
        // it still runs on every navigation.
        // Fullscreen is delegated on purpose: the preview's fullscreen button is
        // inside this frame, and a cross-origin frame without the delegation is
        // refused by permissions policy (the button did nothing and the refusal
        // surfaced as an unhandled rejection). Only this validated frame is granted.
        allow: 'clipboard-read; clipboard-write; fullscreen; microphone',
        allowFullScreen: true,
        referrerPolicy: 'no-referrer',
        style: { display: 'block', width: '100%', height: '100%', border: 0, background: 'var(--dsw-alias-bg-base)' },
      });
    }

    // Do not unmount a slow frame: it may recover with unsaved content intact.
    const silentOverlay = state.status === 'ready' && silent ? h('section', {
      style: { position: 'absolute', inset: 0, zIndex: 35, padding: 24, overflow: 'auto', background: 'var(--dsw-alias-bg-base, #18181b)', color: 'var(--dsw-alias-label-primary)' },
    },
    failureCard('IFRAME_SILENT_TIMEOUT')) : null;

    const banner = archived
      ? h('div', {
        role: 'status',
        style: {
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 40, display: 'flex', flexWrap: 'wrap',
          gap: 8, alignItems: 'center', padding: '8px 12px', fontSize: 12,
          background: 'var(--dsw-alias-bg-layer-2, #2a2a2a)', color: 'var(--dsw-alias-label-primary)',
          borderBottom: '1px solid var(--dsw-alias-separator, #8886)',
        },
      },
      h('span', { style: { flex: '1 1 240px' } }, t('archiveBanner')),
      h('button', { type: 'button', disabled: archiveBusy, onClick: () => changeArchive('unarchive') }, t('archiveRestore')),
      h('button', { type: 'button', disabled: archiveBusy, onClick: () => changeArchive('rebind') }, t('archiveRebind')))
      : null;
    // An archived conversation is read-only: cover the frame so the chat cannot
    // send a turn the Host must refuse (the old 503 toast), and offer the one
    // action that works.
    const archiveOverlay = archived
      ? h('div', {
        role: 'alert',
        style: {
          position: 'absolute', inset: 0, zIndex: 38, display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 24, background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #111) 86%, transparent)',
        },
      }, h('div', {
        style: {
          maxWidth: 380, width: '100%', padding: '20px 22px', borderRadius: 12, textAlign: 'center',
          background: 'var(--dsw-alias-bg-layer-2, #232326)', color: 'var(--dsw-alias-label-primary)',
          border: '1px solid var(--dsw-alias-separator, #8886)',
        },
      },
      h('strong', { style: { display: 'block', fontSize: 14, marginBottom: 6 } }, t('archiveBanner')),
      h('button', {
        type: 'button',
        onClick: () => {
          const frame = iframeRef.current;
          if (!frame || !frame.contentWindow || typeof projectId !== 'string') return;
          try { frame.contentWindow.postMessage({ type: 'no996-openfilm:unarchive', version: 1, projectId }, '*'); } catch { /* frame gone */ }
        },
        style: { marginTop: 12, padding: '7px 16px', borderRadius: 8, cursor: 'pointer' },
      }, t('archiveRestore'))))
      : null;
    return h('div', { style: { position: 'relative', width: '100%', height: '100%', minWidth: 0, minHeight: 0 } },
      studio,
      silentOverlay,
      banner,
      archiveOverlay);
  };
}
