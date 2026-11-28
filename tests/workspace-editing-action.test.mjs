import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkspaceEditingTarget, readWorkspaceEditingTarget } from '../src/ui/workspace-editing-action.mjs';

const target = { projectId: 'projectA', conversationId: 'panel-1', archived: false };

test('workspace action asks the Owner route for the native ID, not the display title', async () => {
  const signal = new AbortController().signal;
  const actual = await readWorkspaceEditingTarget('native-1', signal, async (url, options) => {
    assert.equal(url, '/api/no996-openfilm/editing-session-target');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.signal, signal);
    assert.deepEqual(JSON.parse(options.body), { sessionId: 'native-1' });
    return new Response(JSON.stringify({ target }));
  });
  assert.deepEqual(actual, target);
});

test('workspace lookup distinguishes no binding from failure and rejects invalid responses', async () => {
  const signal = new AbortController().signal;
  assert.equal(await readWorkspaceEditingTarget('native-1', signal, async () => Response.json({ target: null })), null);
  await assert.rejects(readWorkspaceEditingTarget('native-1', signal, async () => Response.json({ target: { ...target, conversationId: '../other' } })), /EDITING_TARGET_INVALID/);
  await assert.rejects(readWorkspaceEditingTarget('native-1', signal, async () => new Response('', { status: 503 })), /EDITING_TARGET_UNAVAILABLE/);
});

test('workspace handoff selects the plugin panel without creating or changing a native conversation', async () => {
  const signal = new AbortController().signal;
  const calls = [];
  assert.equal(await openWorkspaceEditingTarget({
    sessionId: 'native-1', signal,
    readTarget: async (id, actualSignal) => { assert.equal(actualSignal, signal); calls.push(['read', id]); return target; },
    selectPanel: () => calls.push(['panel']),
    navigate: (...args) => calls.push(['navigate', ...args]),
  }), true);
  assert.deepEqual(calls, [['read', 'native-1'], ['panel'], ['navigate', 'projectA', 'panel-1']]);
});

test('unbound, archived, and superseded native selections do not navigate', async () => {
  for (const [value, superseded] of [[null, false], [{ ...target, archived: true }, false], [target, true]]) {
    const controller = new AbortController();
    assert.equal(await openWorkspaceEditingTarget({
      sessionId: 'native-1', signal: controller.signal,
      readTarget: async () => { if (superseded) controller.abort(); return value; },
      selectPanel: () => assert.fail('unexpected panel navigation'),
      navigate: () => assert.fail('unexpected editing target'),
    }), false);
  }
});
