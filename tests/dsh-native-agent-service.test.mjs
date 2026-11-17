import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDshNativeAgentService } from '../src/native/dsh-native-agent-service.mjs';
import { createDshSessionStore } from '../src/native/dsh-session-store.mjs';

function makeProject() {
  const path = mkdtempSync(join(tmpdir(), 'no996-native-film-'));
  return { projectId: 'proj_abc123', path };
}

function createFakeCtx() {
  const created = [];
  const prompts = [];
  const selectedModels = [];
  const cancelled = [];
  const listeners = new Map();
  let nextSeq = 0;

  // Each session gets a queue of follow frames pushed by prompt()
  const queues = new Map();
  const waiters = new Map();
  const existing = new Set();

  const pushFrame = (sessionId, frame) => {
    const wait = waiters.get(sessionId);
    if (wait) {
      waiters.delete(sessionId);
      wait(frame);
      return;
    }
    const q = queues.get(sessionId) ?? [];
    q.push(frame);
    queues.set(sessionId, q);
  };

  const sessionController = {
    async create(req) {
      const sessionId = `sess-${++nextSeq}`;
      created.push({ ...req, sessionId });
      existing.add(sessionId);
      return { sessionId, agentPreset: req.agentPreset };
    },
    async projections({ sessionId }) {
      return existing.has(sessionId)
        ? { kind: 'sequenced', asOfSeq: 1, values: { contextPressure: { contextWindow: 128000, projectedTokens: 16000 } } }
        : null;
    },
    async modelCatalog() {
      return {
        groups: [{
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [{
            id: 'deepseek-chat',
            name: 'DeepSeek Chat',
            reasoning: { defaultEffort: 'medium', efforts: ['low', 'medium', 'high'] },
          }],
        }],
        default: { provider: 'deepseek-official', model: 'deepseek-chat' },
      };
    },
    async selectModel(req) {
      selectedModels.push(req);
      return { selected: req };
    },
    async prompt(req) {
      prompts.push(req);
      queueMicrotask(() => {
        const sid = req.sessionId;
        pushFrame(sid, { type: 'assistant-stream', frame: { type: 'start', attemptId: 'att-1', turn: 1, step: 1 } });
        pushFrame(sid, { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'att-1', index: 0, chunk: { type: 'reasoning-delta', text: '先看分镜' } } });
        pushFrame(sid, { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'att-1', index: 1, chunk: { type: 'text-delta', text: '好的，开始剪辑。' } } });
        pushFrame(sid, { type: 'assistant-stream', frame: { type: 'end', attemptId: 'att-1', index: 2, outcome: { kind: 'committed' } } });
        pushFrame(sid, { type: 'event', event: { type: 'tool/call', data: { callId: 'call-1', name: 'openfilm_film', arguments: '{"op":"read"}' } } });
        pushFrame(sid, { type: 'event', event: { type: 'tool/call', data: { callId: 'call-2', name: 'pwsh', arguments: '{"command":"Get-Date"}' } } });
        pushFrame(sid, { type: 'event', event: { type: 'tool/result', data: { message: { toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: '{"ok":true}' }] } } } });
        pushFrame(sid, { type: 'event', event: { type: 'tool/result', data: { message: { toolCallId: 'call-2', isError: false, content: [{ type: 'text', text: '2026-11-17' }] } } } });
        pushFrame(sid, {
          type: 'event',
          event: {
            type: 'assistant/message',
            data: { message: { id: 'msg-1', content: [{ type: 'reasoning', text: '先看分镜' }, { type: 'text', text: '好的，开始剪辑。' }] } },
          },
        });
        pushFrame(sid, { type: 'event', event: { type: 'compaction/start', seq: 10 } });
        pushFrame(sid, { type: 'event', event: { type: 'compaction/end', seq: 11 } });
        pushFrame(sid, { type: 'event', event: { type: 'turn/end', data: { stopReason: 'end_turn' } } });
      });
      return { accepted: true };
    },
    cancel(req) {
      cancelled.push(req);
      pushFrame(req.sessionId, { type: 'turn/end', data: { stopReason: 'cancelled' } });
      return { accepted: true };
    },
    async *follow(req, signal) {
      assert.equal(req.assistantStream, true, 'follow must opt into assistantStream');
      const sid = req.address.sessionId;
      yield {
        type: 'snapshot',
        cursor: 0,
        records: [],
        hasMore: false,
        projections: { asOfSeq: 0, values: { contextPressure: { contextWindow: 128000, projectedTokens: 4096 } } },
      };
      while (!signal.aborted) {
        const q = queues.get(sid);
        if (q && q.length > 0) {
          yield q.shift();
          continue;
        }
        const frame = await new Promise(resolve => {
          const onAbort = () => resolve(null);
          signal.addEventListener('abort', onAbort, { once: true });
          waiters.set(sid, next => {
            signal.removeEventListener('abort', onAbort);
            resolve(next);
          });
        });
        if (!frame) break;
        yield frame;
      }
    },
  };

  return {
    ctx: {
      sessionController,
      on(event, fn) {
        const set = listeners.get(event) ?? new Set();
        set.add(fn);
        listeners.set(event, set);
        return () => set.delete(fn);
      },
    },
    created,
    prompts,
    selectedModels,
    cancelled,
  };
}

test('native agent creates preset-bound sessions per conversation, streams frames, and authorizes project agents', async () => {
  const project = makeProject();
  const { ctx, created, prompts, selectedModels } = createFakeCtx();
  const store = createDshSessionStore();
  const events = [];

  const service = createDshNativeAgentService({
    ctx,
    verifier: async id => (id === project.projectId ? project : null),
    store,
    emit: async (projectId, event) => { events.push({ projectId, event }); return true; },
    defaultSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
  });

  try {
    const res = await service.send(project.projectId, { conversation: '', key: 'turn-1', turnId: 'turn-1', text: '帮我剪一下' });
    assert.deepEqual(res, { ok: true, stopReason: 'end_turn' });
    assert.equal(created.length, 1);
    assert.equal(created[0].cwd, project.path);
    assert.equal(created[0].agentPreset, 'openfilm-video-editing');
    assert.equal(prompts.length, 1);
    assert.equal(selectedModels.length, 1);

    // Native agent authorization without MCP
    assert.equal(service.isProjectAgent({ session: { id: created[0].sessionId } }), true);
    assert.deepEqual(service.projectOfAgent({ session: { id: created[0].sessionId } }), {
      projectId: project.projectId,
      path: project.path,
      conversation: '',
    });
    assert.equal(service.isProjectAgent({ session: { id: 'unrelated' } }), false);

    // Stream + tool + done events (seal carries seal: true, and agent_message_chunk arrives for claimAttempt)
    const kinds = events.map(e => e.event.kind);
    assert.ok(kinds.includes('stream'));
    assert.ok(kinds.includes('update'));
    assert.equal(kinds[kinds.length - 1], 'done');
    const seals = events.filter(e => e.event.kind === 'stream' && e.event.stream?.t === 'seal');
    assert.ok(seals.length >= 1);
    assert.ok(seals.every(e => e.event.stream.seal === true), 'seal frames must carry seal: true');
    assert.equal(events.some(e => e.event.update?.sessionUpdate === 'agent_message_chunk'), true);
    assert.equal(events.some(e => e.event.update?.sessionUpdate === 'agent_thought_chunk'), false);
    assert.ok(events.some(e => e.event.update?.sessionUpdate === 'tool_call' && e.event.update?.toolName === 'openfilm_film'));
    assert.ok(events.some(e => e.event.update?.sessionUpdate === 'tool_call' && e.event.update?.toolName === 'pwsh' && e.event.update?.kind === 'execute' && e.event.update?.title === 'bash'));
    assert.ok(events.some(e => e.event.update?.sessionUpdate === 'tool_call' && e.event.update?.toolName === 'compaction'));
    assert.ok(events.some(e => e.event.update?.sessionUpdate === 'usage_update' && e.event.update?.used === 4096 && e.event.update?.size === 128000));
    assert.ok(events.some(e => e.event.update?.sessionUpdate === 'usage_update' && e.event.update?.used === 16000 && e.event.update?.size === 128000));
    assert.ok(events.some(e => e.event.update?.sessionUpdate === 'tool_call_update' && e.event.update?.status === 'completed' && e.event.update?.rawOutput));

    // Second conversation opens a distinct DSH session
    await service.send(project.projectId, { conversation: 'conv-2', key: 'turn-2', turnId: 'turn-2', text: '另一条对话' });
    assert.equal(created.length, 2);
    assert.notEqual(created[0].sessionId, created[1].sessionId);
    assert.equal(store.all().length, 2);

    // Thinking & model switching
    const thinking = await service.thinkingOption(project.projectId, '');
    assert.equal(thinking?.currentValue, 'medium');
    await service.selectThinking(project.projectId, 'high', '');
    await service.selectModel(project.projectId, { provider: 'deepseek-official', model: 'deepseek-chat' }, '');
    assert.equal(selectedModels.at(-1).reasoningEffort, 'high');
  } finally {
    await service.close();
  }
});

test('native agent resumes existing sessionId from store when projections finds it', async () => {
  const project = makeProject();
  const { ctx, created } = createFakeCtx();
  // Seed session via create first
  const seeded = await ctx.sessionController.create({ cwd: project.path, agentPreset: 'openfilm-video-editing' });
  const store = createDshSessionStore();
  store.setSession(project.projectId, '', { sessionId: seeded.sessionId, cwd: project.path });

  const service = createDshNativeAgentService({
    ctx,
    verifier: async () => project,
    store,
    emit: async () => true,
  });

  try {
    await service.send(project.projectId, { conversation: '', key: 'k1', turnId: 't1', text: '继续' });
    assert.equal(created.length, 1, 'should not create a second session when stored session exists');
    const state = service.sessionState(project.projectId, '');
    assert.equal(state?.sessionId, seeded.sessionId);
    assert.equal(state?.resumed, true);
  } finally {
    await service.close();
  }
});
