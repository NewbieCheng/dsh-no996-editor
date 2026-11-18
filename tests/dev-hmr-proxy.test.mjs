import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createDevHmrHooks } from '../src/dev/dev-hmr-proxy.mjs';
import { startStudioProxy } from '../src/studio/studio-proxy.mjs';

const KEY = 'e'.repeat(48);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('dev HMR proxy routes UI to Vite with HTML rewrite while /api stays on Studio without leaking key', async (t) => {
  const studioSeen = [];
  const viteSeen = [];

  const studioUp = createServer((req, res) => {
    studioSeen.push({ url: req.url, key: req.headers['x-studio-key'] || '' });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ projects: [{ id: 'p1' }] }));
  });
  const filmUp = createServer((_req, res) => { res.writeHead(200).end(''); });
  const viteUp = createServer((req, res) => {
    viteSeen.push({ url: req.url, key: req.headers['x-studio-key'] || '' });
    if (req.url === '/' || req.url.startsWith('/projects/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>OpenFilm</title><script type="module" src="/@vite/client"></script></head><body><div id="root"></div></body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end('export const hmr = true;');
  });
  viteUp.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`,
    );
    socket.write('vite-ws-ok');
    socket.end();
  });

  const [studioPort, filmPort, vitePort] = await Promise.all([listen(studioUp), listen(filmUp), listen(viteUp)]);
  const devHooks = createDevHmrHooks({
    viteOrigin: `http://127.0.0.1:${vitePort}`,
    liveSse: { attach: (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {"type":"connected"}\n\n'); } },
    styleLabHtml: () => '',
  });

  const prevPort = process.env.NO996_OPENFILM_EDITOR_PORT;
  process.env.NO996_OPENFILM_EDITOR_PORT = '0';
  const proxy = await startStudioProxy({
    upstream: { origin: `http://127.0.0.1:${studioPort}`, filmOrigin: `http://localhost:${filmPort}`, key: KEY },
    authenticateBrowser: () => true,
    webOrigin: 'http://127.0.0.1:5999',
    officialShell: true,
    officialRpc: async () => ({}),
    authorizeOfficialProject: async () => true,
    attachOfficialEvents: async () => {},
    devHooks,
  });
  if (prevPort === undefined) delete process.env.NO996_OPENFILM_EDITOR_PORT;
  else process.env.NO996_OPENFILM_EDITOR_PORT = prevPort;

  t.after(async () => {
    await proxy.close();
    await Promise.all([
      new Promise(r => studioUp.close(r)),
      new Promise(r => filmUp.close(r)),
      new Promise(r => viteUp.close(r)),
    ]);
  });

  const origin = proxy.bootstrapData().editorOrigin;
  const html = await (await fetch(`${origin}/`, { headers: { 'sec-fetch-site': 'same-origin' } })).text();
  assert.match(html, /\/@vite\/client/);
  assert.match(html, /__no996Diag/);
  assert.match(html, /data-no996-dev-hmr/);
  assert.match(html, /openfilmNative/);

  const modRes = await fetch(`${origin}/@vite/client`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(modRes.status, 200);
  assert.match(await modRes.text(), /export const hmr = true/);

  const cssRes = await fetch(`${origin}/__dsh/dev/theme.css?path=/`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(cssRes.status, 200);
  assert.match(await cssRes.text(), /--n996-accent/);

  const apiRes = await fetch(`${origin}/api/projects`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(apiRes.status, 200);
  assert.equal(studioSeen.length, 1);
  assert.equal(studioSeen[0].key, KEY);
  assert.ok(viteSeen.every(entry => entry.key === ''), 'Vite must never receive Studio x-studio-key');

  // Verify HMR WebSocket upgrade succeeds for authenticated same-origin, and rejects foreign origin.
  const proxyUrl = new URL(origin);
  const wsResult = await new Promise((resolve, reject) => {
    const sock = connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) }, () => {
      const wsKey = Buffer.from('1234567890123456').toString('base64');
      sock.write(
        `GET /__dsh_vite_hmr HTTP/1.1\r\nHost: ${proxyUrl.host}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`,
      );
    });
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
  });
  assert.match(wsResult, /101 Switching Protocols/);
  assert.match(wsResult, /vite-ws-ok/);

  const rejected = await new Promise((resolve) => {
    const sock = connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) }, () => {
      const wsKey = Buffer.from('1234567890123456').toString('base64');
      sock.write(
        `GET /__dsh_vite_hmr HTTP/1.1\r\nHost: ${proxyUrl.host}\r\nOrigin: https://evil.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Protocol: vite-hmr\r\n\r\n`,
      );
    });
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  assert.equal(rejected, '');
});
