import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrandTool } from '../src/tools/brand-tool.mjs';

const agent = {};
const binding = { projectId: 'project-A', conversation: 'chat-A', path: '/project-A' };
const active = { mode: 'snapshot', enabled: true, name: 'Private label', identity: 'Plain language for new viewers', logo: { path: 'assets/brand/hidden.png' } };

const fixture = (patch = {}) => createBrandTool({
  isProjectAgent: candidate => candidate === agent,
  projectOf: () => binding,
  verifyProject: async id => { assert.equal(id, binding.projectId); return { path: binding.path }; },
  readSnapshot: async path => { assert.equal(path, binding.path); return active; },
  ...patch,
});

test('only opt-in writing calls can read identity, and they get no display name, logo, or paths', async () => {
  const tool = fixture();
  assert.equal(tool.deferLoading, true);
  for (const purpose of ['narration', 'on-screen-copy']) {
    const result = await tool.execute({ purpose }, { agent });
    assert.match(result.text, /Plain language for new viewers/);
    assert.doesNotMatch(result.text, /Private label|assets\/brand|project-A/);
  }
  await assert.rejects(tool.execute({ purpose: 'export' }, { agent }), /writing purpose/);
  await assert.rejects(tool.execute({ purpose: 'narration', projectId: 'other' }, { agent }), /writing purpose/);
  await assert.rejects(tool.execute({ purpose: 'narration' }, { agent: {} }), /bound OpenFilm/);
  const off = await fixture({ readSnapshot: async () => ({ ...active, mode: 'off' }) }).execute({ purpose: 'narration' }, { agent });
  assert.doesNotMatch(off.text, /Plain language/);
});

test('a placement request reads only the scene rule, never writing identity or profile assets', async () => {
  const placement = { ...active, display: 'logo-name', placement: 'top-left', placementMode: 'fixed' };
  const tool = fixture({ readSnapshot: async () => placement });
  const result = await tool.execute({ purpose: 'placement' }, { agent });
  assert.match(result.text, /assets\/brand\/hidden\.png/);
  assert.match(result.text, /"placement":"top-left"/);
  assert.match(result.text, /"display":"logo-name"/);
  assert.match(result.text, /固定角位不可擅改/);
  assert.doesNotMatch(result.text, /Plain language for new viewers/);
  const none = await fixture({ readSnapshot: async () => null }).execute({ purpose: 'placement' }, { agent });
  assert.match(none.text, /没有已应用的品牌/);
  assert.match(none.text, /不得读取全局资产/);
});

test('stale paths, changed conversation and cancellation never return a writing identity', async () => {
  const moved = fixture({ verifyProject: async () => ({ path: '/other' }), readSnapshot: () => assert.fail('stale path read') });
  await assert.rejects(moved.execute({ purpose: 'narration' }, { agent }), /binding changed/);
  let bound = binding;
  const switched = fixture({ projectOf: () => bound, readSnapshot: async () => {
    bound = { ...binding, conversation: 'chat-B' };
    return active;
  } });
  await assert.rejects(switched.execute({ purpose: 'narration' }, { agent }), /binding changed/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(fixture({ verifyProject: () => assert.fail('used after abort') }).execute({ purpose: 'narration' }, { agent, signal: controller.signal }), { name: 'AbortError' });
});
