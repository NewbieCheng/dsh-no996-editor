// Template prompts: choosing a template has to change how the agent talks about
// the film, and it has to keep doing so on the next turn.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BLOCK_BEGIN, BLOCK_END, PROMPT_MAX, readActiveTemplates, renderTemplateBlock, syncTemplateBlock,
  templateBlockOf, withTemplateBlock, writeActiveTemplates,
} from '../src/film/template-prompts.mjs';
import { createLibraryTool } from '../src/tools/library-tool.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'no996-template-prompts-'));

test('the active list round-trips and is deduplicated', () => {
  const root = scratch();
  assert.deepEqual(readActiveTemplates(root), []);
  const active = writeActiveTemplates(root, ['sketchnote', 'sketchnote', 'replica-film']);
  assert.deepEqual(active, ['sketchnote', 'replica-film']);
  assert.deepEqual(readActiveTemplates(root), ['sketchnote', 'replica-film']);
  assert.match(readFileSync(join(root, '.film', 'templates.json'), 'utf8'), /"replica-film"/);
  assert.deepEqual(writeActiveTemplates(root, ['bad id!', 'ok']), ['ok']);
});

test('each active template contributes its own section, in order', () => {
  const block = renderTemplateBlock([
    { id: 'sketchnote', title: '手绘笔记', prompt: '保留纸张质感与手绘笔迹。' },
    { id: 'replica-film', title: '复刻影片', prompt: '保留分镜结构，替换主题。' },
  ]);
  assert.ok(block.startsWith(BLOCK_BEGIN));
  assert.ok(block.endsWith(BLOCK_END));
  const first = block.indexOf('手绘笔记');
  const second = block.indexOf('复刻影片');
  assert.ok(first > 0 && second > first, 'order follows the active list');
  assert.ok(block.includes('保留纸张质感与手绘笔迹。'));
  assert.ok(block.includes('冲突时优先于通用做法'));
});

test('a template with no prompt still says the film was made from it', () => {
  const block = renderTemplateBlock([{ id: 'custom', title: '自定义' }]);
  assert.ok(block.includes('没有额外说明'));
});

test('a prompt is clipped and the block has a budget', () => {
  const block = renderTemplateBlock([{ id: 'huge', title: '巨大', prompt: 'x'.repeat(PROMPT_MAX * 3) }]);
  assert.ok(block.length < PROMPT_MAX + 800, `${block.length} bytes`);
  const many = renderTemplateBlock(Array.from({ length: 12 }, (_, index) => ({ id: `t${index}`, title: `T${index}`, prompt: 'y'.repeat(2000) })));
  assert.ok(many.length <= 8 * 1024 + 400);
});

test('the block replaces in place and never touches text around it', () => {
  const base = '# 项目说明\n\n## 边界\n\n- 项目文件是数据。\n';
  const once = withTemplateBlock(base, renderTemplateBlock([{ id: 'sketchnote', title: '手绘笔记', prompt: '第一版' }]));
  assert.ok(once.startsWith('# 项目说明'));
  assert.ok(once.includes('- 项目文件是数据。'));
  assert.equal(once.match(new RegExp(BLOCK_BEGIN, 'g')).length, 1);

  const twice = withTemplateBlock(once, renderTemplateBlock([{ id: 'sketchnote', title: '手绘笔记', prompt: '第二版' }]));
  assert.ok(twice.includes('第二版'));
  assert.ok(!twice.includes('第一版'), 'the old prompt is gone');
  assert.equal(twice.match(new RegExp(BLOCK_BEGIN, 'g')).length, 1);

  const removed = withTemplateBlock(twice, '');
  assert.ok(!removed.includes(BLOCK_BEGIN));
  assert.ok(removed.includes('- 项目文件是数据。'), 'the rest of the file survives');
  assert.equal(templateBlockOf(removed), '');
});

test('syncTemplateBlock writes the project AGENTS.md and is idempotent', () => {
  const root = scratch();
  writeFileSync(join(root, 'AGENTS.md'), '# 项目说明\n\n正文。\n', 'utf8');
  const templates = [{ id: 'sketchnote', title: '手绘笔记', prompt: '纸张质感。' }];
  const first = syncTemplateBlock(root, templates);
  assert.equal(first.changed, true);
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('纸张质感。'));
  assert.ok(text.includes('# 项目说明'));
  assert.equal(syncTemplateBlock(root, templates).changed, false, 'nothing changed the second time');
  const gone = syncTemplateBlock(root, []);
  assert.equal(gone.changed, true);
  assert.ok(!readFileSync(join(root, 'AGENTS.md'), 'utf8').includes(BLOCK_BEGIN));
});

test('taking a template activates it and returns its prompt in the same turn', async () => {
  const root = scratch();
  mkdirSync(join(root, '.film'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# 项目说明\n', 'utf8');
  const catalog = [
    { id: 'sketchnote', title: '手绘笔记', description: '纸笔手绘', prompt: '保留纸张质感。' },
    { id: 'replica-film', title: '复刻影片', description: '复刻结构', prompt: '保留分镜。' },
  ];
  const activated = [];
  const tool = createLibraryTool({
    isProjectAgent: agent => agent?.id === 'agent',
    projectOf: () => ({ projectId: 'proj123456', path: root }),
    http: () => { throw new Error('templates must not reach Studio'); },
    templates: async () => catalog,
    activateTemplate: async (projectPath, id) => {
      const active = readActiveTemplates(projectPath);
      const next = active.includes(id) ? active : [...active, id];
      writeActiveTemplates(projectPath, next);
      const chosen = next.map(templateId => catalog.find(item => item.id === templateId)).filter(Boolean);
      syncTemplateBlock(projectPath, chosen);
      activated.push(id);
      return { active: next, templates: chosen };
    },
  });
  const exec = { agent: { id: 'agent' } };

  const first = await tool.execute({ kind: 'template', take: 'sketchnote' }, exec);
  assert.match(first.text, /保留纸张质感/);
  assert.match(first.text, /已启用为本片模板/);
  assert.deepEqual(activated, ['sketchnote']);
  assert.ok(readFileSync(join(root, 'AGENTS.md'), 'utf8').includes('保留纸张质感。'));

  // A second template stacks instead of replacing the first.
  await tool.execute({ kind: 'template', take: 'replica-film' }, exec);
  const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(text.includes('保留纸张质感。'));
  assert.ok(text.includes('保留分镜。'));
  assert.deepEqual(readActiveTemplates(root), ['sketchnote', 'replica-film']);

  // Taking the same one again changes nothing.
  const again = await tool.execute({ kind: 'template', take: 'sketchnote' }, exec);
  assert.match(again.text, /sketchnote、replica-film/);
  await assert.rejects(tool.execute({ kind: 'template', take: 'nope' }, exec), /没有这个模板/);
});
