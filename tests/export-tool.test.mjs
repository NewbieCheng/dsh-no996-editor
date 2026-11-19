import assert from 'node:assert/strict';
import test from 'node:test';
import { createExportTool } from '../src/tools/export-tool.mjs';

function makeAgentEnv({ autoExport = false } = {}) {
  const posts = [];
  const tool = createExportTool({
    isProjectAgent: () => true,
    projectOf: () => ({ projectId: 'proj1234', conversation: 'tab-a' }),
    getWorkMode: async () => ({ mode: 'produce', effective: 'produce', autoExport }),
    http: () => ({
      async get() {
        return {
          can: { h264: true, mp3: true },
          folder: 'F:/films/demo/exports',
          exports: [{ id: 'exp-1', kind: 'video', status: 'done', outputs: ['exports/demo.mp4'] }],
        };
      },
      async post(url, opts) {
        posts.push({ url, opts });
        return { export: { id: 'exp-2', kind: opts?.body?.kind, status: 'queued' } };
      },
      async del() { return { ok: true }; },
    }),
  });
  return { tool, posts };
}

test('export tool blocks automatic final renders when autoExport is off', async () => {
  const { tool, posts } = makeAgentEnv({ autoExport: false });
  const res = await tool.execute({ action: 'start', kind: 'video' }, { agent: {} });
  assert.equal(posts.length, 0, 'must not queue Studio video export when autoExport is off');
  assert.match(res.text, /完成后自动导出.*关闭/);
});

test('export tool still allows inspection stills and explicit user export requests when autoExport is off', async () => {
  const { tool, posts } = makeAgentEnv({ autoExport: false });
  const stills = await tool.execute({ action: 'start', kind: 'stills', at: [1, 2] }, { agent: {} });
  assert.equal(posts.length, 1);
  assert.match(stills.text, /stills 导出/);

  const explicit = await tool.execute({ action: 'start', kind: 'video', explicitUserRequest: true }, { agent: {} });
  assert.equal(posts.length, 2);
  assert.match(explicit.text, /video 导出/);
});

test('export tool runs final video export automatically when autoExport is enabled', async () => {
  const { tool, posts } = makeAgentEnv({ autoExport: true });
  const res = await tool.execute({ action: 'start', kind: 'video', preset: 'tiktok' }, { agent: {} });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].opts.body.kind, 'video');
  assert.match(res.text, /已排队：video 导出/);
});
