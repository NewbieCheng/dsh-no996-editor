import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { runInNewContext } from 'node:vm';
import { startStudioProxy } from '../src/studio/studio-proxy.mjs';

/*
 * The preview's fullscreen button is inside the vendored editor frame and only
 * calls requestFullscreen; it never catches a refusal. A cross-origin frame that
 * is denied fullscreen therefore looked like a dead button plus an unhandled
 * rejection and a red bar. The injected shim must leave the native path alone and
 * turn a refusal into the same visual outcome in place, without painting an error.
 */
const KEY = 'd'.repeat(48);
const APP = '/assets/app.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });

function get(origin, path) {
  const url = new URL(origin + path);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, agent: false, headers: { 'sec-fetch-site': 'same-origin' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function boot() {
  const html = '<!doctype html><html><head><meta charset="utf-8"><script id="app" src="' + APP + '"></script></head><body><div id="root"></div></body></html>';
  const editorUp = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); });
  const filmUp = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(''); });
  const editorPort = await listen(editorUp);
  const filmPort = await listen(filmUp);
  const previous = process.env.NO996_OPENFILM_EDITOR_PORT;
  process.env.NO996_OPENFILM_EDITOR_PORT = '0';
  let proxy;
  try {
    proxy = await startStudioProxy({
      upstream: { origin: `http://127.0.0.1:${editorPort}`, filmOrigin: `http://localhost:${filmPort}`, key: KEY },
      authenticateBrowser: () => true,
      webOrigin: 'http://127.0.0.1:5999',
      officialShell: true,
    });
  } finally {
    if (previous === undefined) delete process.env.NO996_OPENFILM_EDITOR_PORT;
    else process.env.NO996_OPENFILM_EDITOR_PORT = previous;
  }
  return { proxy, origin: proxy.bootstrapData().editorOrigin, async close() { await proxy.close(); await Promise.all([close(editorUp), close(filmUp)]); } };
}

/** A document bare enough for the shim: listeners, a body, and a native getter. */
function fakeDocument() {
  const listeners = new Map();
  const doc = {
    body: { style: {} },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); return true; },
  };
  let nativeElement = null;
  function Document() {}
  Object.defineProperty(Document.prototype, 'fullscreenElement', { configurable: true, get: () => nativeElement });
  return { doc, Document, setNative: value => { nativeElement = value; } };
}

/** The shim's own source, not the diagnostics preload that also opens with `(function(){`. */
function shimScript(html) {
  const marker = html.indexOf('globalThis.__no996Fullscreen');
  assert.ok(marker >= 0, 'the shim is injected into the editor page');
  const start = html.lastIndexOf('<script>', marker);
  return html.slice(start + '<script>'.length, html.indexOf('</script>', marker));
}

function runShim(html, { doc, Document, onNote }) {
  class Element {
    constructor() { this.style = {}; this.attrs = {}; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    removeAttribute(name) { delete this.attrs[name]; }
  }
  // The browser refuses: this is the shape Chromium throws for a frame without
  // the delegation, and it is exactly what used to escape as an unhandled rejection.
  Element.prototype.requestFullscreen = function refused() {
    const error = new TypeError('Disallowed by permissions policy');
    error.name = 'TypeError';
    return Promise.reject(error);
  };
  const sandbox = { document: doc, Document, Element, Event: class { constructor(type) { this.type = type; } }, __no996DiagWarn: onNote };
  sandbox.globalThis = sandbox;
  runInNewContext(shimScript(html), sandbox);
  return Element;
}

test('missing media probes keep the 404, report once per project, and leave the global banner for other failures', async (t) => {
  const studio = await boot();
  t.after(() => studio.close());
  const page = await get(studio.origin, '/');
  assert.equal(page.status, 200);
  const marker = page.body.indexOf('globalThis.__no996Diag)return');
  assert.ok(marker > 0);
  const script = page.body.slice(page.body.lastIndexOf('<script>', marker) + '<script>'.length, page.body.indexOf('</script>', marker));
  const reported = [];
  const bannerChecks = [];
  let status = 404;
  const sandbox = {
    Headers, URLSearchParams, console: { error() {} }, addEventListener() {}, setTimeout() {},
    document: { getElementById(id) { bannerChecks.push(id); return null; } },
    fetch: async (path, options) => {
      if (path === '/__dsh/client-diag') { reported.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); }
      return new Response('{"error":"the file is not there"}', { status });
    },
  };
  runInNewContext(script, sandbox);
  const probe = '/api/projects/project1/media?what=probe&path=assets%2Fphotos%2F';
  for (let i = 0; i < 84; i++) {
    assert.equal((await sandbox.fetch(`${probe}${i}.jpg`)).status, 404);
  }
  assert.equal(reported.length, 1);
  assert.equal(reported[0].code, 'MEDIA_PROBE_MISSING');
  assert.equal(reported[0].detail.projectId, 'project1');
  assert.equal(bannerChecks.length, 0);
  assert.equal((await sandbox.fetch(probe.replace('project1', 'project2') + '2.jpg')).status, 404);
  assert.equal(reported.length, 2);
  await sandbox.fetch('/api/projects/project1');
  status = 503;
  await sandbox.fetch(probe + 'broken.jpg');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reported.map(entry => entry.code), ['MEDIA_PROBE_MISSING', 'MEDIA_PROBE_MISSING', 'HTTP_404', 'HTTP_503']);
  assert.deepEqual(bannerChecks, ['no996-diag', 'no996-diag']);
});

test('a refused fullscreen becomes an in-place zoom instead of an error', async (t) => {
  const studio = await boot();
  t.after(() => studio.close());
  const page = await get(studio.origin, '/');
  assert.equal(page.status, 200);
  // Before the app bundle runs, so the button uses the guarded path.
  assert.ok(page.body.indexOf('__no996Fullscreen') < page.body.indexOf(APP), 'the shim runs before the editor bundle');
  assert.doesNotMatch(shimScript(page.body), /__no996ShowError/, 'a refusal must not paint the red bar');

  const { doc, Document } = fakeDocument();
  const notes = [];
  const Element = runShim(page.body, { doc, Document, onNote: (message, meta) => notes.push({ message, meta }) });
  const element = new Element();
  await element.requestFullscreen();
  assert.equal(doc.fullscreenElement, element);
  assert.equal(element.style.position, 'fixed');
  assert.equal(element.style.width, '100vw');
  assert.equal(element.attrs['data-no996-immersive'], '1');
  assert.equal(doc.body.style.overflow, 'hidden');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].meta.code, 'FULLSCREEN_FALLBACK');

  await doc.exitFullscreen();
  assert.equal(doc.fullscreenElement, null);
  assert.equal(element.style.position, '');
  assert.equal(element.attrs['data-no996-immersive'], undefined);
  assert.equal(doc.body.style.overflow, '');
});

test('the native fullscreen path is untouched', async (t) => {
  const studio = await boot();
  t.after(() => studio.close());
  const page = await get(studio.origin, '/');
  const { doc, Document, setNative } = fakeDocument();
  const notes = [];
  class Element {
    constructor() { this.style = {}; this.attrs = {}; }
    setAttribute() {} removeAttribute() {}
  }
  Element.prototype.requestFullscreen = function native() { setNative(this); return Promise.resolve(); };
  const sandbox = { document: doc, Document, Element, Event: class { constructor(type) { this.type = type; } }, __no996DiagWarn: (m, meta) => notes.push(meta) };
  sandbox.globalThis = sandbox;
  runInNewContext(shimScript(page.body), sandbox);
  const element = new Element();
  await element.requestFullscreen();
  assert.equal(doc.fullscreenElement, element, 'the native element is still what the toggle reads');
  assert.equal(element.style.position, undefined, 'no overlay was invented');
  assert.equal(notes.length, 0);
});

test('Escape leaves the in-place zoom', async (t) => {
  const studio = await boot();
  t.after(() => studio.close());
  const page = await get(studio.origin, '/');
  const { doc, Document } = fakeDocument();
  const Element = runShim(page.body, { doc, Document, onNote: () => {} });
  const element = new Element();
  await element.requestFullscreen();
  let prevented = false;
  doc.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(doc.fullscreenElement, null);
});
