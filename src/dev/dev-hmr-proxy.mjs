import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { theme, themeSurfaceFor } from '../ui/theme.mjs';
import { RESPONSE_HEADERS, SAFE_HEADERS } from '../studio/studio-proxy/upstream.mjs';

const MAX_VITE_RESPONSE = 32 * 1024 * 1024;
const badgeUrl = new URL('./dev-badge-client.js', import.meta.url);
let badgeScript = '';
try {
  badgeScript = readFileSync(fileURLToPath(badgeUrl), 'utf8');
} catch {
  badgeScript = '';
}

export function parseLoopbackViteOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    return null;
  }
  return url;
}

export function isViteUiPath(pathname) {
  if (pathname === '/__dsh' || pathname.startsWith('/__dsh/')) return false;
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  if (pathname === '/p' || pathname.startsWith('/p/')) return false;
  return true;
}

export function createDevHmrHooks({ viteOrigin, liveSse, styleLabHtml, relaxedEmbed = false, say } = {}) {
  const viteUrl = viteOrigin == null ? null : parseLoopbackViteOrigin(viteOrigin);
  if (viteOrigin != null && !viteUrl) throw new TypeError(`Invalid loopback Vite origin: ${viteOrigin}`);

  function headInjection() {
    if (!badgeScript || badgeScript.includes('</script')) return '';
    return `<script data-no996-dev-hmr>${badgeScript}</script>`;
  }

  function themeCssFor(pathname) {
    const html = theme.injection(themeSurfaceFor(pathname, true));
    const match = /^<style[^>]*>([\s\S]*)<\/style>$/i.exec(html);
    return match ? match[1] : '';
  }

  function forwardToVite(req, res, helpers, url) {
    const headers = { host: viteUrl.host, 'accept-encoding': 'identity', 'x-no996-vite-proxy': '1' };
    for (const [name, value] of Object.entries(req.headers)) {
      if (SAFE_HEADERS.has(name) && value !== undefined) headers[name] = value;
    }
    if (req.headers.origin) headers.origin = viteUrl.origin;

    const remote = request({
      hostname: viteUrl.hostname,
      port: viteUrl.port,
      method: req.method,
      path: req.url,
      headers,
    }, (up) => {
      up.on('error', () => {
        if (!res.destroyed && !res.writableEnded) helpers.fail(res, 502);
      });
      const status = up.statusCode || 502;
      const out = {};
      for (const [name, value] of Object.entries(up.headers)) {
        if (RESPONSE_HEADERS.has(name) && typeof value === 'string') out[name] = value;
      }
      out['cache-control'] = 'no-store';
      out['referrer-policy'] = 'no-referrer';
      out['x-content-type-options'] = 'nosniff';
      const type = String(up.headers['content-type'] ?? '').toLowerCase();
      if (helpers.ancestors && (type.startsWith('text/html') || type.startsWith('application/xhtml+xml'))) {
        out['content-security-policy'] = `frame-ancestors ${helpers.ancestors}`;
      }
      const noBody = req.method === 'HEAD' || status === 304 || status === 204 || status === 205;
      res.once('close', () => { if (!res.writableEnded) up.destroy(); });

      void (async () => {
        try {
          if (noBody) {
            up.resume();
            res.writeHead(status, out);
            res.end();
            return;
          }
          const chunks = [];
          let length = 0;
          for await (const chunk of up) {
            length += chunk.length;
            if (length > MAX_VITE_RESPONSE) { up.destroy(); return helpers.fail(res, 502); }
            chunks.push(chunk);
          }
          if (res.destroyed || res.writableEnded) return;
          let body = Buffer.concat(chunks);
          if (type.startsWith('text/html')) {
            const rewritten = await helpers.rewriteHtml(body.toString('utf8'), url, status);
            body = Buffer.from(rewritten, 'utf8');
            delete out.etag;
            delete out['last-modified'];
          }
          const needles = (helpers.forbiddenNeedles || []).map(v => Buffer.from(v));
          if (needles.some(needle => body.includes(needle))) {
            return helpers.fail(res, 502);
          }
          out['content-length'] = String(body.length);
          res.writeHead(status, out);
          res.end(body);
        } catch {
          up.destroy();
          if (!res.destroyed && !res.writableEnded) helpers.fail(res, 502);
        }
      })();
    });

    remote.on('error', (error) => {
      say?.warn?.('dev-vite-upstream-error', { message: String(error?.code || error?.message || error).slice(0, 120) });
      liveSse?.broadcast?.({ type: 'vite-error' });
      if (!res.destroyed && !res.writableEnded) helpers.fail(res, 502);
    });
    req.on('error', () => remote.destroy());
    res.on('close', () => { if (!res.writableEnded) remote.destroy(); });
    req.pipe(remote);
  }

  function handleHttp(req, res, helpers) {
    let url;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) return false;
      url = new URL(req.url, 'http://proxy.invalid');
    } catch {
      return false;
    }

    if (url.pathname === '/__dsh/dev/live' && req.method === 'GET') {
      if (!helpers.permitted(req) || !helpers.authenticated(req)) {
        helpers.fail(res);
        return true;
      }
      liveSse.attach(req, res);
      return true;
    }

    if (url.pathname === '/__dsh/dev/theme.css' && req.method === 'GET') {
      if (!helpers.permitted(req) || !helpers.authenticated(req)) {
        helpers.fail(res);
        return true;
      }
      const targetPath = url.searchParams.get('path') || '/';
      const css = themeCssFor(targetPath);
      res.writeHead(200, {
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-length': Buffer.byteLength(css),
      });
      res.end(css);
      return true;
    }

    if (!viteUrl || !isViteUiPath(url.pathname)) return false;

    const path = decodeURIComponent(url.pathname);
    if (path.includes('\\') || path.split('/').some(part => part === '.' || part === '..')) {
      helpers.fail(res);
      return true;
    }
    if (url.searchParams.has('key') || (helpers.desktop && url.searchParams.has('ticket'))) {
      helpers.fail(res);
      return true;
    }
    if (!helpers.permitted(req) || !helpers.authenticated(req)) {
      helpers.fail(res);
      return true;
    }

    forwardToVite(req, res, helpers, url);
    return true;
  }

  function handleUpgrade(req, socket, head, helpers) {
    if (!viteUrl) return false;
    const protocol = String(req.headers['sec-websocket-protocol'] || '');
    const isHmr = helpers.parsed.pathname === '/__dsh_vite_hmr' || protocol.split(',').map(s => s.trim()).includes('vite-hmr');
    if (!isHmr) return false;

    if (!helpers.permitted(req) || req.headers.origin !== helpers.editorOrigin ||
        !helpers.authenticated(req) ||
        req.headers['sec-websocket-version'] !== '13' ||
        typeof req.headers['sec-websocket-key'] !== 'string' ||
        !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key']) ||
        String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.destroy();
      return true;
    }

    const headers = {
      host: viteUrl.host,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': req.headers['sec-websocket-key'],
      origin: viteUrl.origin,
    };
    if (protocol) headers['sec-websocket-protocol'] = protocol;

    const remote = request({
      hostname: viteUrl.hostname,
      port: viteUrl.port,
      path: req.url,
      headers,
    });

    let peer;
    const close = () => {
      socket.destroy();
      peer?.destroy();
      remote.destroy();
    };
    socket.once('close', close);
    remote.on('error', close);
    remote.on('response', (response) => { response.resume(); close(); });
    remote.on('upgrade', (response, upstreamSocket, upstreamHead) => {
      peer = upstreamSocket;
      peer.on('error', close);
      peer.once('close', close);
      const accept = response.headers['sec-websocket-accept'];
      if (!accept) return close();
      const lines = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
      ];
      if (response.headers['sec-websocket-protocol']) {
        lines.push(`Sec-WebSocket-Protocol: ${response.headers['sec-websocket-protocol']}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) peer.write(head);
      peer.pipe(socket).pipe(peer);
    });
    remote.end();
    return true;
  }

  return Object.freeze({
    viteOrigin: viteUrl?.origin ?? null,
    relaxedEmbed: Boolean(relaxedEmbed),
    styleLabHtml,
    headInjection,
    handleHttp,
    handleUpgrade,
  });
}
