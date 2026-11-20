import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createNo996LlmAdapter, registerNo996LlmProvider } from '../src/native/no996-llm-provider.mjs';

function startMockServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test('no996-llm-provider: advertises auto with image modality and streams Responses SSE + images via JWT', async () => {
  let capturedHeaders = null;
  let capturedBody = null;

  const { server, url } = await startMockServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        data: [{ id: 'auto', name: 'Auto Router', input_modalities: ['text', 'image'] }],
      }));
      return;
    }
    if (req.url === '/v1/responses') {
      capturedHeaders = req.headers;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sendEvt = (evt, data) => res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);
      sendEvt('response.reasoning_summary_text.delta', { delta: 'thinking...' });
      sendEvt('response.output_text.delta', { delta: 'Hello ' });
      sendEvt('response.output_text.delta', { delta: 'vision!' });
      sendEvt('response.completed', {
        response: {
          status: 'completed',
          usage: { input_tokens: 120, output_tokens: 15, total_tokens: 135, input_tokens_details: { cached_tokens: 20 } },
        },
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404).end();
  });

  try {
    let dirty = 0;
    const adapter = createNo996LlmAdapter({
      auth: {
        baseUrl: url,
        dev: false,
        status: async () => ({ loggedIn: true, guest: false }),
        accessToken: async () => 'jwt-live-token',
      },
      resolveAttachments: () => ({
        readImageRequest: async () => ({
          bytes: Uint8Array.from([1, 2, 3, 4]),
          mediaType: 'image/png',
        }),
      }),
      onWalletDirty: () => { dirty++; },
    });

    const models = await adapter.listModels('no996');
    assert.equal(models[0].id, 'auto');
    assert.deepEqual(models[0].inputModalities, ['text', 'image']);

    const chunks = [];
    for await (const chunk of adapter.stream({
      provider: 'no996',
      model: 'auto',
      reasoningEffort: 'high',
      system: 'Be helpful',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', attachment: { attachmentId: 'att-1', width: 64, height: 64, bytes: 4, mediaType: 'image/png' } },
            { type: 'text', text: 'What is in this frame?' },
          ],
        },
      ],
    })) {
      chunks.push(chunk);
    }

    assert.equal(capturedHeaders.authorization, 'Bearer jwt-live-token');
    assert.ok(String(capturedHeaders['user-agent'] || '').includes('deepseek-harness'));
    assert.equal(capturedBody.model, 'auto');
    assert.equal(capturedBody.reasoning.effort, 'high');
    assert.equal(capturedBody.input[0].content[0].type, 'input_image');
    assert.ok(capturedBody.input[0].content[0].image_url.startsWith('data:image/png;base64,'));

    assert.ok(chunks.some(c => c.type === 'reasoning-delta' && c.text === 'thinking...'));
    assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === 'Hello '));
    const usage = chunks.find(c => c.type === 'usage');
    assert.equal(usage?.usage?.inputTokens, 100);
    assert.equal(usage?.usage?.outputTokens, 15);
    assert.equal(dirty, 1);

    // Signed-out adapter still advertises `no996/auto` with a sign-in hint so DSH keeps the group visible
    const signedOutAdapter = createNo996LlmAdapter({
      auth: {
        baseUrl: url,
        dev: false,
        status: async () => ({ loggedIn: false }),
        accessToken: async () => null,
      },
    });
    const signedOutModels = await signedOutAdapter.listModels('no996');
    assert.equal(signedOutModels.length, 1);
    assert.equal(signedOutModels[0].id, 'auto');
    assert.match(signedOutModels[0].name, /需先登录/);
    await assert.rejects(
      async () => {
        for await (const _ of signedOutAdapter.stream({ provider: 'no996', model: 'auto', messages: [] })) {
          // drain
        }
      },
      (err) => err?.code === 'INVALID_CREDENTIAL',
    );

    // Registration refresh triggers handle.replace(['no996']) so DSH re-lists models on login
    let replaced = null;
    const reg = registerNo996LlmProvider({
      llm: {
        registerAdapter(_routes, _adapter) {
          const fn = () => {};
          fn.replace = (next) => { replaced = next; };
          return fn;
        },
      },
    }, { auth: { baseUrl: url } });
    reg.refresh();
    assert.deepEqual(replaced, ['no996']);
  } finally {
    await new Promise(r => server.close(r));
  }
});
