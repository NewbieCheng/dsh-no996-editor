import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createNo996StudioBridge } from '../src/media/no996-studio-bridge.mjs';
import { preferNo996Defaults } from '../src/voice/install-no996-provider.mjs';

function startMockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('no996-studio-bridge: handles image, web-search, and unconfigured video gracefully using Host JWT', async () => {
  const seenAuth = [];
  const { server, url } = await startMockServer(async (req, res) => {
    seenAuth.push(req.headers.authorization || '');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url === '/v1/images/generations') {
      assert.equal(body.model, 'auto');
      assert.equal(body.size, '1536x864');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        created: 123,
        model: 'auto',
        data: [{ b64_json: Buffer.from([137, 80, 78, 71, 1, 2]).toString('base64') }],
      }));
      return;
    }
    if (req.url === '/v1/tools/web_search') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        results: [{ title: 'No996 Docs', url: 'https://example.com', snippet: 'hello world' }],
      }));
      return;
    }
    if (req.url === '/v1/videos/generations') {
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { code: 'VIDEO_GENERATION_NOT_CONFIGURED', message: 'not configured' },
      }));
      return;
    }
    res.writeHead(404).end();
  });

  try {
    let dirtyCount = 0;
    const auth = {
      baseUrl: url,
      dev: false,
      status: async () => ({ loggedIn: true, guest: false }),
      accessToken: async () => 'jwt-studio-token',
    };
    const bridge = createNo996StudioBridge({ auth, onWalletDirty: () => { dirtyCount++; } });

    const img = await bridge.run('image', { prompt: 'cyberpunk sunset', ratio: '16:9', out: 'sunset' }, { say() {} });
    assert.equal(img.files[0].path, 'assets/image/sunset.png');
    assert.equal(img.files[0].bytes.length, 6);
    assert.equal(dirtyCount, 1);

    const search = await bridge.run('web-search', { query: 'openfilm' }, { say() {} });
    assert.equal(search.receipt.provider, 'no996');
    assert.equal(search.receipt.hits[0].title, 'No996 Docs');
    assert.equal(dirtyCount, 2);

    await assert.rejects(
      bridge.run('video', { prompt: 'cat running' }, { say() {} }),
      (err) => err?.code === 'VIDEO_NOT_CONFIGURED',
    );
    assert.ok(seenAuth.every(a => a === 'Bearer jwt-studio-token'));
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('preferNo996Defaults: fills unset verbs without overwriting user explicit choices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'no996-pref-'));
  try {
    const prefFile = join(dir, 'providers.json');
    await writeFile(prefFile, JSON.stringify({ use: { tts: 'elevenlabs' }, other: true }), 'utf8');
    const res = await preferNo996Defaults({ env: { OPENFILM_HOME: dir }, force: false });
    assert.equal(res.changed, true);
    const saved = JSON.parse(await readFile(prefFile, 'utf8'));
    assert.equal(saved.use.tts, 'elevenlabs');
    assert.equal(saved.use.image, 'no996');
    assert.equal(saved.use['web-search'], 'no996');
    assert.equal(saved.other, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
