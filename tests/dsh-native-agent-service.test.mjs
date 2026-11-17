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
      llm: {
        async resolveModelInfo(provider, model) {
          const catalog = await sessionController.modelCatalog();
          const group = catalog.groups.find(g => g.id === provider);
          const hit = group?.models.find(m => m.id === model);
          return {
            id: model,
            name: hit?.name ?? model,
            context: { contextWindow: 128000 },
            ...(hit?.reasoning ? { reasoning: hit.reasoning } : {}),
          };
        },
      },
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

test('attach binds page key and pushes usage before any prompt', async () => {
  const project = makeProject();
  const { ctx } = createFakeCtx();
  const store = createDshSessionStore();
  const events = [];
  const service = createDshNativeAgentService({
    ctx,
    verifier: async () => project,
    store,
    emit: async (projectId, event) => { events.push({ projectId, event }); return true; },
    defaultSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'medium' }),
  });

  try {
    const attached = await service.attach(project.projectId, 'conv-new', { key: 'dsh-page-key' });
    assert.equal(attached.ok, true);
    assert.equal(attached.key, 'dsh-page-key');
    assert.ok(attached.usage?.size > 0, 'usage size must be known without a prompt');
    // Give follow() a tick to also emit its snapshot.
    await new Promise(resolve => setTimeout(resolve, 20));
    const usage = events.filter(e => e.event.update?.sessionUpdate === 'usage_update');
    assert.ok(usage.length >= 1, 'at least one usage_update must be emitted');
    assert.ok(usage.some(e => e.event.key === 'dsh-page-key'), 'usage must use the page key, not dsh-native');
    assert.equal(service.activeKey(project.projectId, 'conv-new'), 'dsh-page-key');
  } finally {
    await service.close();
  }
});

test('resume restores stored model/effort and thinking labels stay Chinese', async () => {
  const project = makeProject();
  const { ctx, created } = createFakeCtx();
  const seeded = await ctx.sessionController.create({ cwd: project.path, agentPreset: 'openfilm-video-editing' });
  const store = createDshSessionStore();
  store.setSession(project.projectId, 'conv-old', {
    sessionId: seeded.sessionId,
    cwd: project.path,
    selection: { provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' },
  });

  const service = createDshNativeAgentService({
    ctx,
    verifier: async () => project,
    store,
    emit: async () => true,
    defaultSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'low' }),
  });

  try {
    await service.attach(project.projectId, 'conv-old', { key: 'dsh-resume' });
    assert.equal(created.length, 1, 'must resume, not create');
    const state = service.sessionState(project.projectId, 'conv-old');
    assert.equal(state?.resumed, true);
    assert.equal(state?.model, 'deepseek-official/deepseek-chat');
    assert.equal(state?.effort, 'high');
    assert.equal(state?.modelSource, 'store');

    const catalog = await service.modelCatalog(project.projectId, 'conv-old');
    assert.equal(catalog.default.model, 'deepseek-chat');

    const thinking = await service.thinkingOption(project.projectId, 'conv-old');
    assert.equal(thinking?.currentValue, 'high');
    assert.deepEqual(thinking?.options.map(o => o.name), ['低', '中', '高']);

    const diag = service.diagnose(project.projectId, 'conv-old');
    assert.equal(diag.modelSource, 'store');
    assert.equal(diag.key, 'dsh-resume');
    assert.ok(diag.usage?.size > 0);
  } finally {
    await service.close();
  }
});

test('selectModel refreshes effort to a supported tier and refuses unsupported thinking', async () => {
  const project = makeProject();
  const { ctx } = createFakeCtx();
  // Extend catalog with a two-tier model.
  const baseCatalog = ctx.sessionController.modelCatalog;
  ctx.sessionController.modelCatalog = async () => {
    const catalog = await baseCatalog();
    catalog.groups[0].models.push({
      id: 'muse-spark',
      name: 'Muse Spark',
      reasoning: { defaultEffort: 'high', efforts: ['off', 'high'] },
    });
    return catalog;
  };

  const store = createDshSessionStore();
  const service = createDshNativeAgentService({
    ctx,
    verifier: async () => project,
    store,
    emit: async () => true,
    defaultSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'medium' }),
  });

  try {
    await service.send(project.projectId, { conversation: '', key: 'dsh-switch', turnId: 't-switch', text: 'hi' });
    await service.selectThinking(project.projectId, 'medium', '');
    await service.selectModel(project.projectId, { provider: 'deepseek-official', model: 'muse-spark' }, '');
    const thinking = await service.thinkingOption(project.projectId, '');
    assert.deepEqual(thinking?.options.map(o => ({ value: o.value, name: o.name })), [
      { value: 'off', name: '关闭' },
      { value: 'high', name: '高' },
    ]);
    assert.equal(thinking?.currentValue, 'high', 'medium must drop to model default when unsupported');
    await assert.rejects(
      () => service.selectThinking(project.projectId, 'medium', ''),
      error => error.code === 'OFFICIAL_AGENT_INPUT',
    );
    const remembered = store.getSession(project.projectId, '');
    assert.equal(remembered?.selection?.model, 'muse-spark');
    assert.equal(remembered?.selection?.reasoningEffort, 'high');
  } finally {
    await service.close();
  }
});

test('probe/attach on blank conversation never creates ghost DSH session or workspace', async () => {
  const project = makeProject();
  const { ctx, created } = createFakeCtx();
  let workspaceCreated = 0;
  ctx.get = name => (name === 'workspaceRegistry'
    ? { list: async () => [], create: async () => { workspaceCreated += 1; return { id: 'ws-bad' }; } }
    : undefined);

  const baseCatalog = ctx.sessionController.modelCatalog;
  ctx.sessionController.modelCatalog = async () => {
    const catalog = await baseCatalog();
    catalog.groups[0].models.push({
      id: 'muse-spark',
      name: 'Muse Spark',
      reasoning: { defaultEffort: 'high', efforts: ['off', 'high'] },
    });
    return catalog;
  };

  const store = createDshSessionStore();
  const service = createDshNativeAgentService({
    ctx,
    verifier: async () => project,
    store,
    emit: async () => true,
    defaultSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'medium' }),
  });

  try {
    const previewValue = Buffer.from(JSON.stringify(['deepseek-official', 'muse-spark'])).toString('base64url');
    const catalog = await service.modelCatalog(project.projectId, '', previewValue);
    assert.equal(catalog.default.model, 'muse-spark');
    const previewThinking = await service.thinkingOption(project.projectId, '', previewValue);
    assert.deepEqual(previewThinking?.options.map(o => o.name), ['关闭', '高']);
    assert.equal(previewThinking?.currentValue, 'high');

    const attached = await service.attach(project.projectId, 'conv-blank', { key: 'dsh-blank-key' });
    assert.equal(attached.ok, true);
    assert.equal(attached.sessionId, null);
    assert.equal(attached.usage?.size, 128000);
    assert.equal(created.length, 0, 'preview and blank attach must not create ghost DSH sessions');
    assert.equal(store.all().length, 0);

    await service.send(project.projectId, { conversation: 'conv-blank', key: 'dsh-blank-key', turnId: 't1', text: '开工' });
    assert.equal(created.length, 1);
    assert.equal(created[0].cwd, project.path);
    assert.equal(workspaceCreated, 0, 'film sessions must never call workspaceRegistry.create');
  } finally {
    await service.close();
  }
});
