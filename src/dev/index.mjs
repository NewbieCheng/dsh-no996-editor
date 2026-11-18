// Dev-only extensions coordinator. Excluded from production `.tgz` builds.
import { isReleasePackage } from '../host/distribution.mjs';
import { styleLabInjection } from '../ui/style-lab.mjs';
import { createDevLiveSse } from './dev-live-sse.mjs';
import { createDevHmrHooks, parseLoopbackViteOrigin } from './dev-hmr-proxy.mjs';
import { startDevBrowserPortal } from './dev-browser-portal.mjs';
import { registerDevRoutes } from './dev-routes.mjs';

export function devFlags(env = process.env) {
  const requestedAny = env.NO996_OPENFILM_DEV === '1'
    || env.NO996_OPENFILM_DEV_HMR === '1'
    || env.NO996_OPENFILM_DEBUG_EDITOR === '1'
    || env.NO996_OPENFILM_OPEN_BROWSER === '1'
    || env.NO996_OPENFILM_STYLE_LAB === '1';
  if (isReleasePackage()) {
    return {
      hmr: false,
      styleLab: false,
      debugEditor: false,
      openBrowser: false,
      any: false,
      blockedByRelease: requestedAny,
    };
  }
  const hmr = env.NO996_OPENFILM_DEV_HMR === '1';
  const styleLab = env.NO996_OPENFILM_STYLE_LAB === '1';
  const debugEditor = env.NO996_OPENFILM_DEBUG_EDITOR === '1' || env.NO996_OPENFILM_DEV === '1';
  const openBrowser = env.NO996_OPENFILM_OPEN_BROWSER !== '0'
    && (hmr || debugEditor || env.NO996_OPENFILM_OPEN_BROWSER === '1');
  return {
    hmr,
    styleLab,
    debugEditor,
    openBrowser,
    any: hmr || styleLab || debugEditor || openBrowser,
    blockedByRelease: false,
  };
}

export function createDevExtensions({
  ctx,
  registerRoute,
  trackRoute,
  officialShell,
  isDisposed,
  getUpstream,
  ensureStudioStarted,
  proxyFor,
  getBridge,
  setBridge,
  getPortalUrl,
  listTemplates,
  templatesRoot,
  say,
  env = process.env,
} = {}) {
  const flags = devFlags(env);
  if (flags.blockedByRelease) {
    say?.warn?.('dev-flags-ignored-in-release-package');
    return null;
  }
  if (!flags.any) return null;

  let liveSse = null;
  let devHooks = null;
  let portalHooks = null;

  if (flags.hmr) {
    const viteOrigin = env.NO996_OPENFILM_VITE_ORIGIN || 'http://127.0.0.1:47825';
    const parsed = parseLoopbackViteOrigin(viteOrigin);
    if (!parsed) throw new Error(`NO996_OPENFILM_VITE_ORIGIN must be a loopback http://127.0.0.1:<port> URL (got ${viteOrigin})`);
    liveSse = createDevLiveSse();
    devHooks = createDevHmrHooks({
      viteOrigin: parsed.origin,
      liveSse,
      styleLabHtml: () => styleLabInjection(env),
      relaxedEmbed: false,
      say,
    });
    portalHooks = createDevHmrHooks({
      viteOrigin: parsed.origin,
      liveSse,
      styleLabHtml: () => styleLabInjection(env),
      relaxedEmbed: true,
      say,
    });
  } else {
    if (flags.openBrowser) {
      liveSse = createDevLiveSse();
      portalHooks = createDevHmrHooks({
        viteOrigin: null,
        liveSse,
        styleLabHtml: () => styleLabInjection(env),
        relaxedEmbed: true,
        say,
      });
    }
    if (flags.styleLab) {
      devHooks = {
        styleLabHtml: () => styleLabInjection(env),
      };
    }
  }

  let routeDisposers = [];
  if (flags.debugEditor || flags.hmr || flags.openBrowser) {
    routeDisposers = registerDevRoutes({
      ctx,
      registerRoute,
      trackRoute,
      officialShell,
      isDisposed,
      getUpstream,
      ensureStudioStarted,
      proxyFor,
      getBridge,
      setBridge,
      getPortalUrl,
      listTemplates,
      templatesRoot,
    });
  }

  return Object.freeze({
    hmrActive: flags.hmr,
    openBrowserActive: flags.openBrowser,
    devHooks,
    portalHooks,
    startBrowserPortal: flags.openBrowser ? (opts) => startDevBrowserPortal({ ...opts, say }) : null,
    dispose() {
      for (const fn of routeDisposers) {
        try { fn(); } catch { /* ignore */ }
      }
      try { liveSse?.close(); } catch { /* ignore */ }
    },
  });
}
