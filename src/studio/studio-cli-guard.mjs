// The packaged OpenFilm CLI starts its own Studio on 127.0.0.1:4747 when it finds
// none (`ensureStudio` in studio/client.mjs) and then asks that Studio to open the
// project — a second owner of the same folder, plus a browser page the person never
// asked for.
//
// The CLI cannot be patched through the shell snapshot (it is the installed
// dependency, not the served UI), and holding the port is not enough on Windows:
// Node listens with SO_REUSEADDR there, so a second listener on 127.0.0.1:4747
// still starts (measured: the CLI bound the guarded port and ran a Studio).
//
// So this answers the CLI as the Studio it is looking for — same health shape, same
// version, same home hash — and turns its "open this project" into a message that
// points at the panel. Nothing else is served: it is not a Studio, and `/api/open`
// never touches film.html.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_STUDIO_PORT = 4747;

/** `studioHome()` in the kernel (studio/server/projects.mjs). */
export function studioHome(env = process.env) {
  return env.OPENFILM_HOME || join(homedir(), '.openfilm');
}

/** The kernel compares this hash, so the CLI must see the home it asked about. */
export function homeDigest(env = process.env) {
  return createHash('sha256').update(studioHome(env)).digest('hex');
}

/** The installed kernel's version: the CLI replaces a Studio older than itself. */
export function installedVersion() {
  try {
    return createRequire(import.meta.url)('openfilm/package.json').version;
  } catch {
    return '0.0.0';
  }
}

function describe(request) {
  return `${request.method ?? ''} ${(request.url ?? '').split('?')[0]}`;
}

/**
 * @param {object} deps
 * @param {number} [deps.port]
 * @param {string} [deps.host]
 * @param {{ info: Function, warn: Function }} deps.log
 * @param {() => boolean} [deps.enabled]
 * @param {string} [deps.version]
 * @param {() => string} [deps.home]
 */
export function createStudioCliGuard({
  port = DEFAULT_STUDIO_PORT,
  host = '127.0.0.1',
  log,
  enabled = () => true,
  version = installedVersion(),
  home = () => homeDigest(),
} = {}) {
  let server = null;
  let hits = 0;
  let opens = 0;
  let state = 'idle';

  const json = (response, body) => {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };

  const handle = (request, response) => {
    hits += 1;
    const route = describe(request);
    if (hits === 1) void log?.info?.('studio-cli-guard-hit', { port, route });
    if (request.url?.startsWith('/api/health')) {
      // The shape `running()` accepts: product, a version the CLI does not replace,
      // the home it asked for, and a film origin.
      return json(response, {
        product: 'openfilm-studio',
        version,
        app: true,
        home: home(),
        filmOrigin: `http://127.0.0.1:${port}`,
        film: false,
      });
    }
    if (request.url?.startsWith('/api/open')) {
      opens += 1;
      void log?.info?.('studio-cli-open-blocked', { port, opens });
      // CLI prints body.url as the address to open; make that the panel's, and keep
      // the project where it is (no path is echoed back).
      return json(response, {
        project: null,
        url: `http://127.0.0.1:${port}/`,
        pages: 0,
      });
    }
    if (request.url === '/' || request.url?.startsWith('/?')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return response.end('<!doctype html><meta charset="utf-8"><title>No996 Studio</title>'
        + '<p>这个项目已经在 DSH 的不加班工作台里打开了：请回到侧栏「视频创作」。</p>'
        + '<p>命令行不需要再开一个 Studio；取画面请在对话里用 no996_frame。</p>');
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end('No996 Studio panel owns this project.');
    return undefined;
  };

  const start = () => new Promise(resolve => {
    if (!enabled()) return resolve({ ok: false, state: (state = 'disabled') });
    if (server) return resolve({ ok: true, state });
    const created = createServer(handle);
    const onError = error => {
      created.close?.();
      server = null;
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      // Someone else's Studio already holds the port: their app works, so step aside —
      // but say so, because the CLI will then use that Studio instead of the panel.
      if (code === 'EADDRINUSE') void log?.warn?.('studio-cli-guard-occupied', { port });
      else void log?.warn?.('studio-cli-guard-failed', { port, code });
      resolve({ ok: false, state: (state = code === 'EADDRINUSE' ? 'occupied' : 'failed') });
    };
    created.once('error', onError);
    created.listen(port, host, () => {
      created.removeListener('error', onError);
      created.on('error', () => { /* one odd request cannot take the guard down */ });
      created.unref?.();
      server = created;
      void log?.info?.('studio-cli-guard', { port, host, version });
      resolve({ ok: true, state: (state = 'held') });
    });
  });

  const stop = () => new Promise(resolve => {
    const current = server;
    server = null;
    if (!current) return resolve();
    try { current.close(() => resolve()); } catch { resolve(); }
  });

  return Object.freeze({
    start,
    stop,
    status: () => ({ state, port, hits, opens }),
  });
}
