import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkbenchAuth } from '../src/auth/workbench-auth.mjs';

function startMockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('workbench-auth: JWT-only Host session never requests or stores static default API keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'no996-jwt-auth-'));
  let defaultKeyCalled = 0;
  let refreshCount = 0;
  const { server, url } = await startMockServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url === '/api/v1/auth/login' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        data: {
          access_token: 'jwt-initial',
          refresh_token: 'rt-1',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          user_id: 42,
        },
      }));
      return;
    }
    if (req.url?.includes('/api/v1/me/api-keys/default')) {
      defaultKeyCalled++;
      res.writeHead(500).end('should not be called');
      return;
    }
    if (req.url === '/api/v1/auth/refresh' && req.method === 'POST') {
      refreshCount++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        data: {
          access_token: 'jwt-refreshed',
          refresh_token: 'rt-2',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          user_id: 42,
        },
      }));
      return;
    }
    if (req.url === '/api/v1/me/api-capabilities' && req.method === 'GET') {
      if (req.headers.authorization === 'Bearer jwt-initial') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }));
        return;
      }
      assert.equal(req.headers.authorization, 'Bearer jwt-refreshed');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { endpoints: [] } }));
      return;
    }
    if (req.url === '/api/v1/auth/logout' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end();
  });

  try {
    const auth = createWorkbenchAuth({ baseUrl: url, home, dev: false });
    await auth.login({ account: 'u@example.com', password: 'password123' });

    assert.equal(typeof auth.ensureDefaultApiKey, 'undefined');
    assert.equal(typeof auth.getDefaultApiKeySecret, 'undefined');
    assert.equal(defaultKeyCalled, 0);

    const diskRaw = await readFile(join(home, 'no996-openfilm', 'workbench-auth.json'), 'utf8');
    assert.equal(diskRaw.includes('defaultApiKey'), false);
    assert.equal(diskRaw.includes('sk-no996'), false);

    // 401 triggers single-flight refresh & transparent retry
    const caps = await auth.authedRequest('/api/v1/me/api-capabilities');
    assert.deepEqual(caps, { endpoints: [] });
    assert.equal(refreshCount, 1);
    assert.equal(await auth.accessToken(), 'jwt-refreshed');

    await auth.logout();
    const afterLogout = await readFile(join(home, 'no996-openfilm', 'workbench-auth.json'), 'utf8');
    assert.equal(afterLogout.trim(), 'null');
  } finally {
    await new Promise(r => server.close(r));
    await rm(home, { recursive: true, force: true });
  }
});
