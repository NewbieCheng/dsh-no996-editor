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

test('workbench-auth: ensureDefaultApiKey & rotateDefaultApiKey store secret only in Host', async () => {
  const home = await mkdtemp(join(tmpdir(), 'no996-auth-'));
  let ensureCount = 0;
  let rotateCount = 0;
  const { server, url } = await startMockServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url === '/api/v1/auth/login' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        data: {
          access_token: 'jwt-1',
          refresh_token: 'rt-1',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          user_id: 42,
        },
      }));
      return;
    }
    if (req.url === '/api/v1/me/api-keys/default' && req.method === 'POST') {
      ensureCount++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        data: {
          created: true,
          secret_retrievable: true,
          api_key: { api_key_id: 7, key_name: 'no996-default', masked_key: 'sk-no996-ab****yz', rpm_limit: 60, daily_tokens: 0 },
          api_key_plaintext: 'sk-no996-secret-first',
        },
      }));
      return;
    }
    if (req.url === '/api/v1/me/api-keys/default/rotate' && req.method === 'POST') {
      rotateCount++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        data: {
          api_key: { api_key_id: 7, key_name: 'no996-default', masked_key: 'sk-no996-cd****99', rpm_limit: 60, daily_tokens: 0 },
          api_key_plaintext: 'sk-no996-secret-rotated',
        },
      }));
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

    const first = await auth.ensureDefaultApiKey();
    assert.equal(first.ready, true);
    assert.equal(first.maskedKey, 'sk-no996-ab****yz');
    assert.equal(Object.hasOwn(first, 'secret'), false);
    assert.equal(ensureCount, 1);
    assert.equal(await auth.getDefaultApiKeySecret(), 'sk-no996-secret-first');

    // Second ensure returns cached without network call
    await auth.ensureDefaultApiKey();
    assert.equal(ensureCount, 1);

    // Status snapshot must NEVER leak secret
    const status = await auth.status();
    assert.equal(JSON.stringify(status).includes('sk-no996-secret'), false);

    // Rotate issues new secret & persists to disk
    const rotated = await auth.rotateDefaultApiKey();
    assert.equal(rotateCount, 1);
    assert.equal(rotated.maskedKey, 'sk-no996-cd****99');
    assert.equal(await auth.getDefaultApiKeySecret(), 'sk-no996-secret-rotated');

    // Logout clears secret
    await auth.logout();
    assert.equal(await auth.getDefaultApiKeySecret(), null);
    const onDisk = await readFile(join(home, 'no996-openfilm', 'workbench-auth.json'), 'utf8');
    assert.equal(onDisk.trim(), 'null');
  } finally {
    await new Promise(r => server.close(r));
    await rm(home, { recursive: true, force: true });
  }
});
