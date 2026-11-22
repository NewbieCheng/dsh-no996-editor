import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function readPatchFor(sourceSuffix) {
  const series = JSON.parse(await readFile(new URL('../patches/series.json', import.meta.url), 'utf8'));
  const entry = series.patches.find((p) => p.source.endsWith(sourceSuffix));
  assert.ok(entry, `missing patch entry for ${sourceSuffix} in patches/series.json`);
  return readFile(new URL(`../patches/${entry.file}`, import.meta.url), 'utf8');
}

test('live model selection fails closed without scope and only updates the requested conversation', async () => {
  const patch = await readPatchFor('apps/desktop/chat/src/lib/local-agent-run.ts');
  const body = patch.match(/^\+export async function applyLiveSessionOption\([\s\S]*?^[+ ]\}/m)?.[0];
  assert.ok(body, 'the shipped source patch includes the scoped selector');
  const js = body.replace(/^\+/gm, '').replace(/export async function applyLiveSessionOption\([\s\S]*?\)[:\s\S]*?\{\n/, 'async function applyLiveSessionOption(agent, configId, value, scope) {\n');
  const calls = [];
  const allowed = [{ id: 'model', options: [{ value: 'new' }] }];
  const sessions = new Map([['p:a:deepseek', { key: 'target-a', info: { configOptions: allowed } }], ['p:b:deepseek', { key: 'target-b', info: { configOptions: allowed } }]]);
  const apply = vm.runInNewContext(`${js}\napplyLiveSessionOption`, {
    sessions, attaching: new Map(),
    desktopBridge: () => ({ localAgents: { setOption: async (...args) => { calls.push(args); return { ok: true, result: { configOptions: allowed } }; } } }),
  });
  assert.equal(await apply('deepseek', 'model', 'new'), null);
  assert.equal(await apply('deepseek', 'model', 'new', { projectId: 'p', conversation: 'missing' }), null);
  assert.equal(await apply('deepseek', 'model', 'old', { projectId: 'p', conversation: 'b' }), null);
  assert.equal(await apply('deepseek', 'model', 'new', { projectId: 'p', conversation: 'b' }), allowed);
  assert.deepEqual(calls, [['target-b', 'model', 'new']]);
  const app = await readPatchFor('apps/desktop/chat/src/App.tsx');
  const store = await readPatchFor('apps/desktop/chat/src/state/local-agent-store.ts');
  const popover = await readPatchFor('apps/desktop/chat/src/components/ModelPopover.tsx');
  assert.match(app, /sessionScope=\{\{ projectId: projectKey, conversation: sessionId \}\}/);
  assert.match(app, /applyLiveSessionOption\(agent, opt\.id, wanted, \{ projectId: projectKey, conversation: sessionId \}\)/);
  assert.match(store, /applyLiveSessionOption\(agent, configId, value, scope\)/);
  assert.match(popover, /setPref\(agent, o\.id, value, sessionScope\)/);
});
