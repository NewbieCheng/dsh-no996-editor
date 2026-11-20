import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGetTool } from '../src/tools/get-tool.mjs';

test('no996_get forwards unified image options (out/ratio/size/quality/ref/via/model) to /api/get', async () => {
  const bypassTool = fileURLToPath(new URL('../src/tools/image-gen-tool.mjs', import.meta.url));
  assert.equal(existsSync(bypassTool), false, 'redundant bypass image-gen-tool.mjs should be removed');

  const calls = [];
  const tool = createGetTool({
    isProjectAgent: () => true,
    projectOf: () => ({ projectId: 'proj-1', path: '/tmp/film-demo' }),
    http: () => ({
      async post(path, options) {
        calls.push({ path, body: options.body });
        return { ok: true, text: 'assets/image/hero_cover.png' };
      },
    }),
  });

  const out = await tool.execute({
    verb: 'image',
    prompt: 'minimalist neon studio',
    out: 'hero_cover',
    ratio: '16:9',
    size: '2k',
    quality: 'high',
    ref: ['assets/frame.png'],
    via: 'no996',
    model: 'auto',
  }, { agent: {} });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/get');
  assert.deepEqual(calls[0].body, {
    folder: '/tmp/film-demo',
    verb: 'image',
    args: {
      prompt: 'minimalist neon studio',
      out: 'hero_cover',
      ratio: '16:9',
      size: '2k',
      quality: 'high',
      ref: 'assets/frame.png',
    },
    via: 'no996',
    model: 'auto',
  });
  assert.match(out.text, /assets\/image\/hero_cover\.png/);
});
