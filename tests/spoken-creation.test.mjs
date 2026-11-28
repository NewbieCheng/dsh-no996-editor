import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFilmFile } from 'openfilm/film-doc';
import { createDshAskAgent } from '../src/host/dsh-ai.mjs';
import { createSpokenCreation } from '../src/studio/spoken-creation.mjs';

const body = { requestId: '6c4c6a7f-3efe-48e2-bd28-efcca31643bb', ratio: '16:9', copy: '先做一个小实验。', music: 'none' };
const response = JSON.stringify({ beats: [{ from: 0, to: 1, role: 'action', headline: '先试一次', visual: '分步流程图', motion: '按步骤点亮节点' }] });

async function fixture(t, options = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'no996-spoken-create-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const paths = [];
  const proxy = { createProject: async path => {
    paths.push(path);
    if (options.failRegistration) throw new Error('response lost');
    return { id: 'project-example', path };
  } };
  const create = createSpokenCreation({ ask: () => response, projectParent: async () => parent, ...options });
  return { create, proxy, parent, paths };
}

test('the configured default text model only receives the script/ratio, and duplicate requests register once', async t => {
  let calls = 0;
  const ask = createDshAskAgent({ agentDefaultModel: { currentSelection: () => ({ provider: 'mock-route', model: 'mock-model' }) },
    llm: { async *stream(request) {
      calls++;
      assert.equal(request.provider, 'mock-route');
      assert.equal(request.model, 'mock-model');
      const prompt = request.messages[0].content[0].text;
      assert.match(prompt, /先做一个小实验/);
      assert.doesNotMatch(prompt, /6c4c6a7f|project-example/);
      yield { type: 'text-delta', text: response };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } },
  });
  const { create, proxy, paths } = await fixture(t, { ask });
  const [first, repeat] = await Promise.all([create(body, proxy), create({ ...body }, proxy)]);
  assert.equal(first, repeat);
  assert.equal(calls, 1);
  assert.equal(paths.length, 1);
  assert.deepEqual(await create(body, proxy), first);
  assert.equal(first.projectId, 'project-example');
  assert.equal(first.timing, 'estimated');
  assert.equal(Object.hasOwn(first, 'path'), false);
  const { doc, problems } = readFilmFile(await readFile(join(paths[0], 'film.html'), 'utf8'));
  assert.deepEqual(problems, []);
  assert.deepEqual(doc.stage, { w: 1920, h: 1080 });
  assert.equal(doc.tracks.length, 1);
  await assert.rejects(create({ ...body, ratio: '9:16' }, proxy), { code: 'SPOKEN_REQUEST_CONFLICT' });
});

test('invalid inputs and failed model or audio leave the project library unchanged', async t => {
  const { create, proxy, parent } = await fixture(t, { ask: () => { throw Error('secret test value'); } });
  await assert.rejects(create({ ...body, projectId: 'other' }, proxy), { code: 'SPOKEN_BLUEPRINT_INPUT' });
  await assert.rejects(create({ ...body, music: 'upload', audioBase64: '///=' }, proxy), { code: 'SPOKEN_BGM_INPUT' });
  await assert.rejects(create(body, proxy), { code: 'SPOKEN_MODEL_FAILED', message: 'SPOKEN_MODEL_FAILED' });
  assert.deepEqual(await readdir(parent), []);
});

test('a lost registration reply is not retried and a bookkeeping failure does not hide the project', async t => {
  const uncertain = await fixture(t, { failRegistration: true });
  for (let i = 0; i < 2; i++) await assert.rejects(uncertain.create(body, uncertain.proxy), { code: 'TEMPLATE_REGISTRATION_UNCERTAIN' });
  assert.equal(uncertain.paths.length, 1);
  assert.equal((await readdir(uncertain.parent)).length, 1);
  const warning = await fixture(t, { remember: () => { throw new Error('cannot store settings'); } });
  const created = await warning.create(body, warning.proxy);
  assert.equal(created.projectId, 'project-example');
  assert.deepEqual(created.warnings, ['SPOKEN_BOOKKEEPING_FAILED']);
});
