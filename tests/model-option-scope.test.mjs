import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('live model selection fails closed without scope and only updates the requested conversation', async () => {
  const patch = await readFile(new URL('../patches/220-local-agent-run.patch', import.meta.url), 'utf8');
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
  const app = await readFile(new URL('../patches/010-App.patch', import.meta.url), 'utf8');
  const store = await readFile(new URL('../patches/230-local-agent-store.patch', import.meta.url), 'utf8');
  const popover = await readFile(new URL('../patches/070-ModelPopover.patch', import.meta.url), 'utf8');
  assert.match(app, /sessionScope=\{\{ projectId: projectKey, conversation: sessionId \}\}/);
  assert.match(app, /applyLiveSessionOption\(agent, opt\.id, wanted, \{ projectId: projectKey, conversation: sessionId \}\)/);
  assert.match(store, /applyLiveSessionOption\(agent, configId, value, scope\)/);
  assert.match(popover, /setPref\(agent, o\.id, value, sessionScope\)/);
});
