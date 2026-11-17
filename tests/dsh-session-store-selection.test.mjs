import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshSessionStore } from '../src/native/dsh-session-store.mjs';

test('session store remembers per-conversation model selection', () => {
  const store = createDshSessionStore();
  store.setSession('proj_abc123', 'conv-a', {
    sessionId: 'sess-1',
    cwd: 'C:\\film',
    selection: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' },
  });
  store.setSession('proj_abc123', 'conv-b', {
    sessionId: 'sess-2',
    selection: { provider: 'deepseek-official', model: 'muse-spark', reasoningEffort: 'off' },
  });

  assert.deepEqual(store.getSession('proj_abc123', 'conv-a')?.selection, {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    reasoningEffort: 'high',
  });
  assert.equal(store.getSession('proj_abc123', 'conv-b')?.selection?.model, 'muse-spark');

  store.setSelection('proj_abc123', 'conv-a', {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
    reasoningEffort: 'low',
  });
  assert.equal(store.getSession('proj_abc123', 'conv-a')?.selection?.reasoningEffort, 'low');
  assert.equal(store.getSession('proj_abc123', 'conv-a')?.sessionId, 'sess-1');
});

test('legacy project-level model string still hydrates the default conversation', () => {
  const store = createDshSessionStore();
  store.set('proj_abc123', { sessionId: 'sess-legacy', model: 'deepseek-official/deepseek-chat' });
  const known = store.get('proj_abc123');
  assert.equal(known?.sessionId, 'sess-legacy');
  assert.deepEqual(known?.selection, { provider: 'deepseek-official', model: 'deepseek-chat' });
});
