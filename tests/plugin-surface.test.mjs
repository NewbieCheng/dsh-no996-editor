import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createPluginSurfaceProxy } from '../src/studio/studio-proxy/plugin-surface.mjs';
import { listen, shutdown } from '../src/studio/studio-proxy/upstream.mjs';

const editor = 'http://127.0.0.2:47822';
const upstreamEditor = 'http://127.0.0.1:12345';

test('workspace surfaces translate only trusted origins and keep Studio in charge of project writes', async () => {
  const seen = [];
  const events = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, path: req.url, origin: req.headers.origin, cookie: req.headers.cookie, studioKey: req.headers['x-studio-key'], tag: req.headers['if-match'] });
    const headers = { 'content-type': 'text/javascript', 'content-security-policy': "default-src 'self'" };
    if (req.headers.origin === upstreamEditor) {
      headers['access-control-allow-origin'] = upstreamEditor;
      headers['access-control-expose-headers'] = 'etag';
    }
    if (req.method === 'OPTIONS') {
      headers['access-control-allow-methods'] = 'GET, HEAD, PUT';
      headers['access-control-allow-headers'] = 'if-match, content-type';
      return res.writeHead(204, headers).end();
    }
    if (req.method === 'PUT') return res.writeHead(412, headers).end('changed');
    res.writeHead(200, headers).end('export default class extends HTMLElement {}');
  });
  const port = await listen(server, '127.0.0.1');
  let surface;
  const proxy = createPluginSurfaceProxy({ host: `localhost:${port}`, port, origin: `http://localhost:${port}` }, () => ({ editor, surface, upstreamEditor }), (...args) => events.push(args));
  try {
    surface = `http://127.0.0.1:${await listen(proxy, '127.0.0.1')}`;
    const route = '/s/grant-token/ui.js?v=version';
    let reply = await fetch(surface + route, { headers: { origin: editor, cookie: 'host-secret', 'x-studio-key': 'bad' } });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('access-control-allow-origin'), editor);
    assert.equal(reply.headers.get('content-security-policy'), "default-src 'self'");
    assert.match(await reply.text(), /^export default/);
    assert.deepEqual(seen[0], { method: 'GET', path: route, origin: upstreamEditor, cookie: undefined, studioKey: undefined, tag: undefined });
    reply = await fetch(surface + route, { headers: { origin: 'https://untrusted.example' } });
    assert.equal(reply.status, 403);
    await reply.body.cancel();
    reply = await fetch(surface + '/api/projects');
    assert.equal(reply.status, 403);
    await reply.body.cancel();
    assert.equal(seen.length, 1);
    reply = await fetch(surface + '/f/project-grant/film.html', { method: 'OPTIONS', headers: { origin: editor, 'access-control-request-method': 'PUT' } });
    assert.equal(reply.status, 204);
    assert.match(reply.headers.get('access-control-allow-methods'), /PUT/);
    reply = await fetch(surface + '/f/project-grant/film.html', { method: 'PUT', headers: { origin: editor, 'if-match': 'old' }, body: 'draft' });
    assert.equal(reply.status, 412);
    assert.equal(await reply.text(), 'changed');
    assert.equal(seen[2].tag, 'old');
    assert.deepEqual(events, [['PUT', 'f', 412]]);
  } finally { await Promise.all([shutdown(proxy), shutdown(server)]); }
});

test('plugin surface CORS also allows configured viewer origins (dev portal front door)', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.origin);
    const headers = { 'content-type': 'text/javascript' };
    if (req.headers.origin === upstreamEditor) {
      headers['access-control-allow-origin'] = upstreamEditor;
      headers['access-control-expose-headers'] = 'etag';
    }
    res.writeHead(200, headers).end('export default class extends HTMLElement {}');
  });
  const port = await listen(server, '127.0.0.1');
  const viewer = 'http://127.0.0.1:47821';
  let surface;
  const proxy = createPluginSurfaceProxy(
    { host: `localhost:${port}`, port, origin: `http://localhost:${port}` },
    () => ({ editor, surface, upstreamEditor, viewers: [viewer] }),
    () => {},
  );
  try {
    surface = `http://127.0.0.1:${await listen(proxy, '127.0.0.1')}`;
    const route = '/s/grant-token/ui.js?v=version';
    const reply = await fetch(surface + route, { headers: { origin: viewer } });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('access-control-allow-origin'), viewer);
    assert.match(await reply.text(), /^export default/);
    assert.deepEqual(seen, [upstreamEditor]);
    const blocked = await fetch(surface + route, { headers: { origin: 'http://127.0.0.1:9999' } });
    assert.equal(blocked.status, 403);
    await blocked.body.cancel();
  } finally { await Promise.all([shutdown(proxy), shutdown(server)]); }
});
