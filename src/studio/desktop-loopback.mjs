import { createServer } from 'node:http';

/**
 * Minimal production loopback bridge for `dsh-app://app` desktop surfaces.
 *
 * Unlike the dev-only editor console (`src/dev/`), this module serves ONLY the
 * two JSON endpoints required by the desktop Electron shell (`/api/studio-url`
 * and `/api/auth`) and never exposes standalone HTML editor or template debug
 * pages in production builds.
 */
export function startDesktopLoopback({
  port = Number(process.env.NO996_OPENFILM_DEBUG_PORT || 47821),
  editorUrl = () => null,
  authHandler = null,
} = {}) {
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
        const cors = {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
          'cache-control': 'no-store',
        };
        if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
        const location = await editorUrl();
        if (!location) {
          res.writeHead(503, { ...cors, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'editor not ready' }));
          return;
        }
        const target = new URL(location);
        const body = JSON.stringify({ origin: target.origin, ticket: target.hash.replace(/^#/, '') });
        res.writeHead(200, { ...cors, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }).end(body);
        return;
      }

      if (url.pathname === '/api/auth' && (req.method === 'POST' || req.method === 'OPTIONS')) {
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
        if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
        if (!allowedOrigin) {
          res.writeHead(403, { ...cors, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'ORIGIN' }));
          return;
        }
        if (typeof authHandler !== 'function') {
          res.writeHead(503, { ...cors, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'UNAVAILABLE' }));
          return;
        }
        try {
          let size = 0;
          const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 64 * 1024) {
              res.writeHead(413, { ...cors, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'BODY_LIMIT' }));
              return;
            }
            chunks.push(chunk);
          }
          const result = await authHandler(Buffer.concat(chunks).toString('utf8'));
          const body = JSON.stringify(result.body);
          res.writeHead(result.status, { ...cors, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }).end(body);
        } catch {
          res.writeHead(503, { ...cors, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'UNAVAILABLE' }));
        }
        return;
      }

      res.writeHead(404, { 'cache-control': 'no-store' }).end();
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const addr = server.address();
      resolve({
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}
