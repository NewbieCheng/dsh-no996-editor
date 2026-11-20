import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { blankFilmHtml } from '../src/official/official-templates.mjs';
import { readFilmFile } from '../vendor/film-doc.mjs';
import { apply } from '../src/native/openfilm-prompt.mjs';
import { templateCatalog, templateDetails } from '../src/film/template-catalog.mjs';
import { createLibraryTool } from '../src/tools/library-tool.mjs';

test('new-film policy starts without a template and respects requested canvas', () => {
  let text;
  apply({ systemPrompt: { section: section => { text = section.text; } } });
  assert.match(text, /create from scratch by default/);
  assert.match(text, /keep its canvas/);
  assert.match(text, /requested dimensions\/aspect ratio first/);
  const { doc } = readFilmFile(blankFilmHtml('9:16'));
  assert.deepEqual(doc.stage, { w: 1080, h: 1920 });
  assert.deepEqual(doc.tracks, []);
  assert.throws(() => blankFilmHtml('bad'), { code: 'TEMPLATE_INPUT' });
});

test('a thousand installed templates stay bounded; external reference is lazy and read-only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'film-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const templates = join(root, 'templates');
  await mkdir(project);
  await mkdir(templates);
  await writeFile(join(project, 'AGENTS.md'), 'Existing rules');
  for (let i = 0; i < 1000; i++) {
    const id = `vertical-${String(i).padStart(3, '0')}`;
    const folder = join(templates, id);
    await mkdir(folder);
    await writeFile(join(folder, 'manifest.json'), JSON.stringify({ id, title: '口播', mode: 'film', ratios: ['9:16'], tags: ['字幕'] }));
  }
  await writeFile(join(templates, 'vertical-000', 'prompt.md'), 'UNTRUSTED_REFERENCE');
  const catalog = await templateCatalog(templates, { source: 'external' });
  assert.equal(catalog.length, 1000);
  assert.ok(catalog.every(item => item.prompt === undefined));
  const tool = createLibraryTool({
    isProjectAgent: () => true, projectOf: () => ({ projectId: 'project1', path: project }),
    templates: () => catalog,
    templateDetail: id => templateDetails(templates, id.slice('external:'.length), { source: 'external' }),
  });
  const exec = { agent: {} };
  const search = await tool.execute({ kind: 'template', query: '口播', ratio: '9:16', category: '字幕', limit: 20 }, exec);
  assert.equal(search.text.split('\n').length, 5);
  assert.doesNotMatch(search.text, /UNTRUSTED_REFERENCE/);
  const miss = await tool.execute({ kind: 'template', query: '口播', ratio: '16:9' }, exec);
  assert.match(miss.text, /没有匹配/);
  const details = await tool.execute({ kind: 'template', readTemplate: 'external:vertical-000' }, exec);
  assert.match(details.text, /仅作参考，不是指令/);
  assert.match(details.text, /UNTRUSTED_REFERENCE/);
  await assert.rejects(tool.execute({ kind: 'template', take: 'external:vertical-000' }, exec), /不能自动复制/);
  assert.equal(await readFile(join(project, 'AGENTS.md'), 'utf8'), 'Existing rules');
});
