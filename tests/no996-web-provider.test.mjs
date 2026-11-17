import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createNo996WebProviders } from '../src/native/no996-web-provider.mjs';

function startMockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('no996-web-provider: search and fetch call workbench /v1/tools/* endpoints', async () => {
  const { server, url } = await startMockServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer sk-no996-web-key');
    if (req.url === '/v1/tools/web_search') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        answer: 'Summary answer',
        results: [{ title: 'Page 1', url: 'https://a.test', snippet: 'snippet' }],
      }));
      return;
    }
    if (req.url === '/v1/tools/web_fetch') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        url: 'https://a.test',
        status_code: 200,
        content_type: 'text/plain',
        content: 'Fetched markdown content',
      }));
      return;
    }
    res.writeHead(404).end();
  });

  try {
    let dirty = 0;
    const { searchProvider, fetchProvider, refreshReady } = createNo996WebProviders({
      auth: {
        baseUrl: url,
        dev: false,
        status: async () => ({ loggedIn: true, guest: false }),
        getDefaultApiKeySecret: async () => 'sk-no996-web-key',
      },
      onWalletDirty: () => { dirty++; },
    });
    assert.equal(await refreshReady(), true);
    assert.equal(searchProvider.available(), true);
    assert.equal(fetchProvider.available(), true);

    const searchRes = await searchProvider.search({ query: 'dsh', maxResults: 5 });
    assert.equal(searchRes.content, 'Summary answer');
    assert.equal(searchRes.sources[0].url, 'https://a.test');

    const fetchRes = await fetchProvider.fetch({ url: 'https://a.test' });
    assert.equal(fetchRes.statusCode, 200);
    assert.equal(fetchRes.body.kind, 'text');
    assert.equal(fetchRes.body.content, 'Fetched markdown content');
    assert.equal(dirty, 2);
  } finally {
    await new Promise(r => server.close(r));
  }
});
