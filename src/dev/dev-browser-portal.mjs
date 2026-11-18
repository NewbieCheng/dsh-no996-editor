// Dev-only permanent open browser portal on `:47821` (excluded from release `.tgz`).
//
// Keeps Electron loopback endpoints (`/api/studio-url`, `/api/auth`) intact
// while upgrading `GET /` on `127.0.0.1:47821` into a cookie-free, ticket-free,
// embed-friendly OpenFilm workbench backed by the real DSH Studio & Host.
import { createServer, request } from 'node:http';
import { startStudioProxy } from '../studio/studio-proxy.mjs';

const MAX_WAIT_MS = 5000;

function writeJson(res, status, cors, bodyObj) {
  const body = JSON.stringify(bodyObj);
  res.writeHead(status, {
    ...cors,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function loadingHtml() {
  return '<!doctype html><meta charset="utf-8"><title>正在启动 OpenFilm Studio (Dev)…</title>'
    + '<meta http-equiv="refresh" content="1">'
    + '<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#141414;color:#e5e5e5;font:14px/1.6 system-ui,sans-serif}</style>'
    + '<div>正在连接 DSH OpenFilm Studio，页面将在就绪后自动进入…</div>'
    + '<script>setTimeout(function(){location.reload()},700);</script>';
}

function forwardHeaders(rawHeaders, targetHost, publicOrigin, altOrigin, internalOrigin) {
  const headers = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (value !== undefined) headers[name] = value;
  }
  headers.host = targetHost;
  if (headers.origin === publicOrigin || headers.origin === altOrigin) {
    headers.origin = internalOrigin;
  }
  return headers;
}

export async function startDevBrowserPortal({
  port = Number(process.env.NO996_OPENFILM_DEBUG_PORT || 47821),
  editorUrl = () => null,
  authHandler = null,
  ensureStudioStarted = async () => {},
  createProxyOptions = () => null,
  say = null,
} = {}) {
  let closed = false;
  let internalProxy = null;
  let currentUpstream = null;
  let pendingAttach = null;
  const waiters = new Set();

  function notifyWaiters() {
    for (const wake of [...waiters]) {
      waiters.delete(wake);
      wake();
    }
  }

  function clearWaiter(wake) {
    waiters.delete(wake);
  }

  async function waitForInternalProxy(timeoutMs = MAX_WAIT_MS) {
    if (internalProxy || closed) return internalProxy;
    void Promise.resolve().then(() => ensureStudioStarted()).catch(() => {});
    if (pendingAttach) {
      await Promise.race([pendingAttach.catch(() => {}), new Promise(r => setTimeout(r, timeoutMs))]);
      if (internalProxy || closed) return internalProxy;
    }
    return new Promise((resolve) => {
      let timer;
      const wake = () => {
        clearTimeout(timer);
        clearWaiter(wake);
        resolve(internalProxy);
      };
      timer = setTimeout(wake, timeoutMs);
      waiters.add(wake);
    });
  }

  let actualPort = 0;
  let publicOrigin = '';
  let altOrigin = '';

  async function setUpstream(studio) {
    currentUpstream = studio || null;
    const prev = internalProxy;
    internalProxy = null;
    if (prev) await prev.close().catch(() => {});
    if (!studio || closed) return null;

    const task = (async () => {
      const opts = await createProxyOptions(studio, publicOrigin);
      if (!opts || closed || currentUpstream !== studio) return null;
      const created = await startStudioProxy({
        ...opts,
        upstream: studio,
        webOrigin: publicOrigin,
        listenPort: 0,
        desktop: false,
        authenticateBrowser: () => true,
      });
      if (closed || currentUpstream !== studio) {
        await created.close().catch(() => {});
        return null;
      }
      internalProxy = created;
      notifyWaiters();
      return created;
    })();
    pendingAttach = task;
    try {
      return await task;
    } finally {
      if (pendingAttach === task) pendingAttach = null;
    }
  }

  async function handleStudioUrl(req, res) {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    const location = await editorUrl();
    if (!location) {
      writeJson(res, 503, cors, { error: 'editor not ready' });
      return;
    }
    const target = new URL(location);
    writeJson(res, 200, cors, {
      origin: target.origin,
      ticket: target.hash.replace(/^#/, ''),
    });
  }

  async function handleAuth(req, res) {
    const origin = String(req.headers.origin || '');
    const allowedOrigin = !origin || origin === 'dsh-app://app' || origin === 'app://app' || origin === 'null';
    const cors = {
      'access-control-allow-origin': allowedOrigin ? (origin || 'dsh-app://app') : 'null',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (!allowedOrigin) {
      writeJson(res, 403, cors, { error: 'ORIGIN' });
      return;
    }
    if (typeof authHandler !== 'function') {
      writeJson(res, 503, cors, { error: 'UNAVAILABLE' });
      return;
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64 * 1024) {
          writeJson(res, 413, cors, { error: 'BODY_LIMIT' });
          return;
        }
        chunks.push(chunk);
      }
      const result = await authHandler(Buffer.concat(chunks).toString('utf8'));
      writeJson(res, result.status, cors, result.body);
    } catch {
      writeJson(res, 503, cors, { error: 'UNAVAILABLE' });
    }
  }

  const sockets = new Set();

  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end();
      return;
    }

    void (async () => {
      if (url.pathname === '/api/studio-url' && (req.method === 'GET' || req.method === 'OPTIONS')) {
        await handleStudioUrl(req, res);
        return;
      }
      if (url.pathname === '/api/auth' && (req.method === 'POST' || req.method === 'OPTIONS')) {
        await handleAuth(req, res);
        return;
      }

      const host = String(req.headers.host || '');
      const isLoopback127 = host === `127.0.0.1:${actualPort}`;
      const isLocalhost = host === `localhost:${actualPort}`;
      if (!isLoopback127 && !isLocalhost) {
        res.writeHead(403, { 'cache-control': 'no-store' }).end('Forbidden');
        return;
      }
      if (isLocalhost && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(302, { location: `${publicOrigin}${req.url}`, 'cache-control': 'no-store' }).end();
        return;
      }

      if ((url.pathname === '/editor' || url.pathname === '/shell') && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(302, { location: '/', 'cache-control': 'no-store' }).end();
        return;
      }

      const targetProxy = internalProxy || await waitForInternalProxy();
      if (!targetProxy || closed) {
        if ((req.method === 'GET' || req.method === 'HEAD') && String(req.headers.accept || '').includes('text/html')) {
          const html = loadingHtml();
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(html),
          }).end(req.method === 'HEAD' ? undefined : html);
          return;
        }
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
          .end('DSH OpenFilm Studio is starting…');
        return;
      }

      const internalUrl = new URL(targetProxy.editorOrigin);
      const headers = forwardHeaders(req.headers, internalUrl.host, publicOrigin, altOrigin, internalUrl.origin);
      const remote = request({
        hostname: internalUrl.hostname,
        port: internalUrl.port,
        method: req.method,
        path: req.url,
        headers,
      }, (up) => {
        const outHeaders = { ...up.headers };
        if (typeof outHeaders.location === 'string' && outHeaders.location.startsWith(internalUrl.origin)) {
          outHeaders.location = publicOrigin + outHeaders.location.slice(internalUrl.origin.length);
        }
        res.writeHead(up.statusCode || 502, outHeaders);
        up.pipe(res);
      });
      remote.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'cache-control': 'no-store' });
        if (!res.writableEnded && !res.destroyed) res.end();
      });
      res.once('close', () => {
        if (!res.writableEnded) remote.destroy();
      });
      req.on('error', () => remote.destroy());
      req.pipe(remote);
    })();
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
      socket.destroy();
      return;
    }
    const targetProxy = internalProxy;
    if (!targetProxy || closed) {
      socket.destroy();
      return;
    }
    const internalUrl = new URL(targetProxy.editorOrigin);
    const headers = forwardHeaders(req.headers, internalUrl.host, publicOrigin, altOrigin, internalUrl.origin);
    const remote = request({
      hostname: internalUrl.hostname,
      port: internalUrl.port,
      method: req.method,
      path: req.url,
      headers,
    });
    sockets.add(socket);
    let peer = null;
    const cleanup = () => {
      sockets.delete(socket);
      socket.destroy();
      peer?.destroy();
      remote.destroy();
    };
    socket.once('close', cleanup);
    remote.on('error', cleanup);
    remote.on('response', (upRes) => {
      upRes.resume();
      cleanup();
    });
    remote.on('upgrade', (upRes, upstreamSocket, upstreamHead) => {
      peer = upstreamSocket;
      peer.on('error', cleanup);
      peer.once('close', cleanup);
      const lines = [`HTTP/1.1 ${upRes.statusCode || 101} ${upRes.statusMessage || 'Switching Protocols'}`];
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (Array.isArray(v)) {
          for (const item of v) lines.push(`${k}: ${item}`);
        } else if (v !== undefined) {
          lines.push(`${k}: ${v}`);
        }
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) peer.write(head);
      peer.pipe(socket).pipe(peer);
    });
    remote.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number.isInteger(port) && port >= 0 && port < 65536 ? port : 47821, '127.0.0.1', () => {
      server.off('error', reject);
      actualPort = server.address().port;
      publicOrigin = `http://127.0.0.1:${actualPort}`;
      altOrigin = `http://localhost:${actualPort}`;
      say?.info?.('dev-browser-portal-ready', { url: `${publicOrigin}/` });
      resolve();
    });
  });

  return Object.freeze({
    port: actualPort,
    url: `${publicOrigin}/`,
    origin: publicOrigin,
    setUpstream,
    async close() {
      closed = true;
      notifyWaiters();
      for (const s of sockets) s.destroy();
      sockets.clear();
      const prev = internalProxy;
      internalProxy = null;
      if (prev) await prev.close().catch(() => {});
      await new Promise((done) => server.close(done));
    },
  });
}
