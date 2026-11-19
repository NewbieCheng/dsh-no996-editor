import { createServer, request } from 'node:http';
import { fail } from './upstream.mjs';

const requestHeaders = ['accept', 'content-length', 'content-type', 'if-match', 'if-none-match', 'range'];
const responseHeaders = ['content-length', 'content-type', 'etag', 'allow', 'accept-ranges', 'content-range', 'content-security-policy'];

// Keep workbench pages on their own origin. Studio still owns the opaque
// /s/ and /f/ grants and decides whether the plugin may write a project file.
export function createPluginSurfaceProxy(target, origins, onFailure) {
  const server = createServer((req, res) => {
    const { editor, surface, upstreamEditor } = origins();
    const origin = req.headers.origin;
    if (!surface || req.headers.host !== new URL(surface).host || (origin && origin !== editor && origin !== surface)) return fail(res);
    const path = req.url || '';
    const match = /^\/(s|f)\/[A-Za-z0-9_-]+\/(?!\/)[^?#]*(?:\?[^#]*)?$/.exec(path);
    if (!match || path.includes('\\') || !['GET', 'HEAD', 'OPTIONS', 'PUT'].includes(req.method)) return fail(res);
    if (!['GET', 'HEAD'].includes(req.method) && (!origin || match[1] !== 'f')) return fail(res);
    const headers = { host: target.host, 'accept-encoding': 'identity' };
    for (const name of requestHeaders) if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    if (origin) headers.origin = origin === editor ? upstreamEditor : target.origin;
    if (req.headers['sec-fetch-site']) headers['sec-fetch-site'] = req.headers['sec-fetch-site'];
    const requestedMethod = req.headers['access-control-request-method'];
    if (req.method === 'OPTIONS') {
      if (origin !== editor || requestedMethod !== 'PUT') return fail(res);
      headers['access-control-request-method'] = requestedMethod;
      if (req.headers['access-control-request-headers']) headers['access-control-request-headers'] = req.headers['access-control-request-headers'];
    }
    const remote = request({ hostname: '127.0.0.1', port: target.port, method: req.method, path, headers }, up => {
      const status = up.statusCode || 502;
      if ((status >= 300 && status < 400 && status !== 304) || (up.headers['content-encoding'] && up.headers['content-encoding'] !== 'identity')) {
        up.resume(); onFailure(req.method, match[1], 502); return fail(res, 502);
      }
      const out = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', vary: 'Origin' };
      for (const name of responseHeaders) if (up.headers[name] !== undefined) out[name] = up.headers[name];
      if (origin === editor && up.headers['access-control-allow-origin'] === upstreamEditor) {
        out['access-control-allow-origin'] = editor;
        for (const name of ['access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers']) {
          if (up.headers[name] !== undefined) out[name] = up.headers[name];
        }
      }
      if (status >= 400) onFailure(req.method, match[1], status);
      res.writeHead(status, out);
      up.on('error', () => res.destroy());
      up.pipe(res);
    });
    remote.on('error', () => {
      onFailure(req.method, match[1], 502);
      if (!res.headersSent && !res.destroyed) fail(res, 502);
      else res.destroy();
    });
    remote.setTimeout(30000, () => remote.destroy());
    res.on('close', () => { if (!res.writableEnded) remote.destroy(); });
    req.on('error', () => remote.destroy());
    req.pipe(remote);
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}
