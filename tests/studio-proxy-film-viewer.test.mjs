import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startStudioProxy } from '../src/studio/studio-proxy.mjs';

/**
 * Dev portal (:47821) fronts an ephemeral editorOrigin. The film bridge's
 * EDITOR must be the public door Origin, or parent.postMessage(..., EDITOR)
 * is dropped and Preview stays on "Drawing the first frame".
 */
const KEY = 'a'.repeat(48);
const VIEWER = 'http://127.0.0.1:47821';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });

test('film HTML EDITOR and CORS use the viewer Origin when viewerOrigins are set', async (t) => {
  let upstreamEditorOrigin = '';
  const filmUp = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><script>const EDITOR = ${JSON.stringify(upstreamEditorOrigin)};</script>`);
  });
  const editorUp = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>editor</title>');
  });
  const editorPort = await listen(editorUp);
  const filmPort = await listen(filmUp);
  upstreamEditorOrigin = `http://127.0.0.1:${editorPort}`;
  const previous = process.env.NO996_OPENFILM_EDITOR_PORT;
  process.env.NO996_OPENFILM_EDITOR_PORT = '0';
  const proxy = await startStudioProxy({
    upstream: { origin: upstreamEditorOrigin, filmOrigin: `http://localhost:${filmPort}`, key: KEY },
    authenticateBrowser: () => true,
    webOrigin: VIEWER,
    viewerOrigins: [VIEWER, 'http://localhost:47821'],
    officialShell: true,
    officialRpc: async () => ({}),
    authorizeOfficialProject: async () => true,
    attachOfficialEvents: async () => {},
  });
  if (previous === undefined) delete process.env.NO996_OPENFILM_EDITOR_PORT;
  else process.env.NO996_OPENFILM_EDITOR_PORT = previous;

  t.after(async () => {
    await proxy.close();
    await Promise.all([close(editorUp), close(filmUp)]);
  });

  assert.ok(proxy.filmOrigin);
  assert.notEqual(proxy.editorOrigin, VIEWER);

  const html = await fetch(`${proxy.filmOrigin}/p/token-abc/film.html`);
  assert.equal(html.status, 200);
  const body = await html.text();
  assert.match(body, new RegExp(`const EDITOR = ${JSON.stringify(VIEWER)}`));
  assert.doesNotMatch(body, new RegExp(`const EDITOR = ${JSON.stringify(proxy.editorOrigin)}`));
  assert.equal(html.headers.get('access-control-allow-origin'), VIEWER);

  const cors = await fetch(`${proxy.filmOrigin}/p/token-abc/film.html`, {
    headers: { origin: VIEWER, 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(cors.status, 200);
  assert.equal(cors.headers.get('access-control-allow-origin'), VIEWER);
  await cors.body.cancel();

  const foreign = await fetch(`${proxy.filmOrigin}/p/token-abc/film.html`, {
    headers: { origin: 'http://127.0.0.1:9999' },
  });
  assert.equal(foreign.status, 403);
  await foreign.body.cancel();
});

test('without viewerOrigins, film HTML EDITOR stays the ephemeral editorOrigin', async (t) => {
  let upstreamEditorOrigin = '';
  const filmUp = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><script>const EDITOR = ${JSON.stringify(upstreamEditorOrigin)};</script>`);
  });
  const editorUp = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html>');
  });
  const editorPort = await listen(editorUp);
  const filmPort = await listen(filmUp);
  upstreamEditorOrigin = `http://127.0.0.1:${editorPort}`;
  const previous = process.env.NO996_OPENFILM_EDITOR_PORT;
  process.env.NO996_OPENFILM_EDITOR_PORT = '0';
  const proxy = await startStudioProxy({
    upstream: { origin: upstreamEditorOrigin, filmOrigin: `http://localhost:${filmPort}`, key: KEY },
    authenticateBrowser: () => true,
    webOrigin: 'http://127.0.0.1:5999',
    officialShell: true,
    officialRpc: async () => ({}),
    authorizeOfficialProject: async () => true,
    attachOfficialEvents: async () => {},
  });
  if (previous === undefined) delete process.env.NO996_OPENFILM_EDITOR_PORT;
  else process.env.NO996_OPENFILM_EDITOR_PORT = previous;

  t.after(async () => {
    await proxy.close();
    await Promise.all([close(editorUp), close(filmUp)]);
  });

  const html = await fetch(`${proxy.filmOrigin}/p/token-abc/film.html`);
  assert.equal(html.status, 200);
  assert.match(await html.text(), new RegExp(`const EDITOR = ${JSON.stringify(proxy.editorOrigin)}`));
});
