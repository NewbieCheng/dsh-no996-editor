import test from 'node:test';
import assert from 'node:assert/strict';
import { createFontsTool, buildFontStack } from '../src/tools/fonts-tool.mjs';

const link = {
  isProjectAgent: agent => agent?.ok === true,
  projectOf: () => ({ projectId: 'film123', path: 'C:/films/demo' }),
};

test('no996_fonts lists system, project, and bundled OFL fonts and builds fallback stacks', async () => {
  const calls = [];
  const http = () => ({
    async get(path) {
      calls.push(path);
      if (path === '/api/fonts') {
        return {
          fonts: [
            { family: 'LXGW WenKai', aliases: ['霞鹜文楷'], locale: 'zh-CN', weights: [400, 700] },
            { family: 'Inter', locale: 'latin', weights: [400, 600, 700] },
          ],
        };
      }
      if (path === '/api/projects/film123/fonts') {
        return { fonts: [{ family: 'BrandSans', weights: [700] }] };
      }
      return {};
    },
  });

  const tool = createFontsTool({ ...link, http });
  assert.equal(tool.name, 'no996_fonts');

  const all = await tool.execute({}, { agent: { ok: true } });
  assert.deepEqual(calls, ['/api/fonts', '/api/projects/film123/fonts']);
  assert.match(all.text, /Smiley Sans/);
  assert.match(all.text, /ZCOOL KuaiLe/);
  assert.match(all.text, /BrandSans/);
  assert.match(all.text, /LXGW WenKai \(霞鹜文楷\)/);
  assert.match(all.text, /--font/);

  const aliased = await tool.execute({ query: '霞鹜', locale: 'zh-CN' }, { agent: { ok: true } });
  assert.match(aliased.text, /LXGW WenKai/);
  assert.doesNotMatch(aliased.text, /Inter/);

  const missing = await tool.execute({ query: '不存在的幻想字体' }, { agent: { ok: true } });
  assert.match(missing.text, /未找到匹配/);

  assert.equal(
    buildFontStack(['Smiley Sans', 'PingFang SC']),
    "'Smiley Sans', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', sans-serif",
  );
});

test('no996_fonts refuses unbound conversations', async () => {
  const tool = createFontsTool({ ...link, http: () => ({ get: async () => ({}) }) });
  await assert.rejects(tool.execute({}, { agent: { ok: false } }), /only to a conversation bound/);
});
