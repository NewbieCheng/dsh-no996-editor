// In-process native DSH SessionController driver for the OpenFilm panel.
//
// Replaces the `dsh --profile acp` child process, `acp-stream-tap` TCP socket,
// and MCP loopback server with direct calls to `ctx.sessionController` inside
// the Host process. Each conversation opens a real DSH Session bound to the
// `openfilm-video-editing` preset (`cwd = project.path`).
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const PROJECT_ID = /^[A-Za-z0-9_-]{6,40}$/;
const CONVERSATION = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_PRESET = 'openfilm-video-editing';

const failure = (code, detail) => Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
const text = value => typeof value === 'string' && value.length > 0;

function parseToolArgs(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch { return value; }
}

/**
 * Map DSH native tool names onto the ACP `title` / `kind` / `rawInput` shapes
 * that OpenFilm's compiled `localToolActivity` promotes to persistent rows
 * (instead of collapsing into ephemeral `working`).
 */
function mapToolCallForUi(name, rawInput) {
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
  const lower = String(name || '').toLowerCase();
  if (lower.startsWith('openfilm_')) {
    return { title: name, toolName: name, kind: 'other', rawInput: input };
  }
  if (lower === 'pwsh' || lower === 'bash' || lower === 'shell' || lower === 'terminal') {
    const cmd = input.command ?? input.cmd ?? input.script ?? '';
    return {
      title: 'bash',
      toolName: name,
      kind: 'execute',
      rawInput: { ...input, ...(typeof cmd === 'string' && cmd ? { command: cmd } : {}) },
    };
  }
  if (lower === 'read' || lower === 'read_image' || lower === 'read_file' || lower === 'view_file') {
    const p = input.path ?? input.file_path ?? input.file ?? '';
    return {
      title: 'read',
      toolName: name,
      kind: 'read',
      rawInput: { ...input, ...(typeof p === 'string' && p ? { path: p } : {}) },
    };
  }
  if (lower === 'glob' || lower === 'grep' || lower === 'search') {
    const q = input.pattern ?? input.query ?? input.path ?? '';
    return {
      title: 'grep',
      toolName: name,
      kind: 'search',
      rawInput: { ...input, ...(typeof q === 'string' && q ? { pattern: q, query: q } : {}) },
    };
  }
  if (lower === 'write' || lower === 'edit' || lower === 'write_file' || lower === 'edit_file') {
    const p = input.path ?? input.file_path ?? input.file ?? '';
    return {
      title: 'edit',
      toolName: name,
      kind: 'edit',
      rawInput: { ...input, ...(typeof p === 'string' && p ? { path: p } : {}) },
    };
  }
  if (lower === 'web_search' || lower === 'web_fetch') {
    const q = input.query ?? input.url ?? '';
    return {
      title: name,
      toolName: name,
      kind: lower === 'web_search' ? 'search' : 'fetch',
      rawInput: { ...input, ...(typeof q === 'string' && q ? { query: q } : {}) },
    };
  }
  if (lower === 'skill') {
    const s = input.name ?? input.skill ?? '';
    return {
      title: 'read',
      toolName: 'skill',
      kind: 'read',
      rawInput: { ...input, ...(typeof s === 'string' && s ? { path: `skill:${s}` } : {}) },
    };
  }
  return { title: name, toolName: name, kind: 'other', rawInput: input };
}

function convertToolContent(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      out.push({ type: 'content', content: { type: 'text', text: block.text } });
    }
  }
  return out;
}

/**
 * Create an in-process native DSH conversation service matching the outward
 * contract expected by `official-chat-rpc` and `studio-controller`.
 *
 * @param {object} deps
 * @param {object} deps.ctx - DSH Cordis context (`sessionController`, `sessions`, `on`, `get`)
 * @param {(projectId: string) => Promise<{projectId: string, path: string}>} deps.verifier
 * @param {object} deps.store - `createDshSessionStore()` instance
 * @param {(projectId: string, event: object) => Promise<boolean>|boolean} deps.emit
 * @param {(projectId: string, projectPath: string) => Promise<void>} [deps.prepareProject]
 * @param {() => {provider?: string, model?: string, reasoningEffort?: string}|undefined} [deps.defaultSelection]
 * @param {string} [deps.agentPreset]
 * @param {(event: string, fields?: object) => void} [deps.log]
 */
export function createDshNativeAgentService({
  ctx,
  verifier,
  store,
  emit,
  prepareProject,
  defaultSelection = () => undefined,
  agentPreset = DEFAULT_PRESET,
  log,
}) {
  if (!ctx?.sessionController || typeof verifier !== 'function' || typeof emit !== 'function' ||
      !store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('ctx.sessionController, verifier, store and emit are required');
  }

  const projects = new Map();
  const sessionProjects = new Map();
  let closed = false;

  const projectStateOf = projectId => {
    if (!PROJECT_ID.test(projectId)) throw failure('OFFICIAL_AGENT_INPUT', 'invalid project');
    let state = projects.get(projectId);
    if (state) return state;
    state = { projectId, projectPath: '', sessions: new Map() };
    projects.set(projectId, state);
    return state;
  };

  const sessionStateOf = (projectState, conversation) => {
    const id = typeof conversation === 'string' && CONVERSATION.test(conversation) ? conversation : '';
    let session = projectState.sessions.get(id);
    if (session) return session;
    session = {
      conversation: id,
      sessionId: undefined,
      reopened: false,
      key: undefined,
      ready: undefined,
      followAbort: undefined,
      followPromise: undefined,
      inflight: undefined,
      model: undefined,
      reasoningEffort: undefined,
      lastUsed: Date.now(),
      turnStats: { deltas: 0, seals: 0, syncs: 0, textCommits: 0 },
    };
    projectState.sessions.set(id, session);
    return session;
  };

  const sessionById = sessionId => {
    for (const projectState of projects.values()) {
      for (const session of projectState.sessions.values()) {
        if (session.sessionId === sessionId) return { projectState, session };
      }
    }
    return undefined;
  };

  const offError = typeof ctx.on === 'function'
    ? ctx.on('api-session/error', (sessionId, message) => {
        const hit = sessionById(sessionId);
        if (!hit?.session.inflight) return;
        hit.session.inflight.reject(new Error(String(message || 'Session error')));
      })
    : undefined;

  const offStatus = typeof ctx.on === 'function'
    ? ctx.on('api-session/status', (sessionId, running) => {
        if (running !== false) return;
        const hit = sessionById(sessionId);
        if (!hit?.session.inflight) return;
        // Give durable `turn/end` frames a brief moment to arrive before settling.
        const { projectState, session } = hit;
        const timer = setTimeout(() => {
          if (!session.inflight) return;
          settleTurn(projectState.projectId, session, {
            ok: true,
            stopReason: session.inflight.cancelled ? 'cancelled' : 'end_turn',
          });
        }, 120);
        timer.unref?.();
      })
    : undefined;

  function stopFollow(session) {
    if (session.followAbort) {
      try { session.followAbort.abort(); } catch { /* already aborted */ }
      session.followAbort = undefined;
    }
    session.followPromise = undefined;
  }

  function settleTurn(projectId, session, { ok, stopReason, error } = {}) {
    const inflight = session.inflight;
    if (!inflight) return;
    session.inflight = undefined;
    if (ok) {
      inflight.resolve({ ok: true, stopReason: stopReason || 'end_turn' });
    } else {
      inflight.reject(new Error(error || 'turn failed'));
    }
  }

  async function handleFollowFrame(projectState, session, frame, streamState) {
    const { projectId } = projectState;
    const key = session.key ?? 'dsh-native';

    if (!frame || typeof frame !== 'object' || frame.type === 'snapshot') return;

    if (frame.type === 'assistant-stream') {
      const inner = frame.frame;
      if (!inner || typeof inner !== 'object') return;
      if (inner.type === 'start') {
        if (inner.turn !== streamState.turn) {
          streamState.turn = inner.turn;
          streamState.thought = '';
          streamState.streamedThought = false;
        }
        streamState.attempt = inner.attemptId ?? streamState.attempt;
        streamState.text = '';
        streamState.streamedText = false;
        void Promise.resolve(emit(projectId, {
          key,
          kind: 'stream',
          stream: { t: 'start', attempt: streamState.attempt, turn: inner.turn, step: inner.step, sessionId: session.sessionId },
        })).catch(() => {});
        return;
      }
      if (inner.type === 'chunk') {
        const chunk = inner.chunk;
        if (!chunk || typeof chunk !== 'object') return;
        if (chunk.type === 'reasoning-delta' && text(chunk.text)) {
          streamState.thought += chunk.text;
          streamState.streamedThought = true;
          session.turnStats.deltas += 1;
          void Promise.resolve(emit(projectId, {
            key,
            kind: 'stream',
            stream: { t: 'delta', attempt: streamState.attempt, index: inner.index, kind: 'thought', turn: streamState.turn, sessionId: session.sessionId, text: chunk.text },
          })).catch(() => {});
        } else if (chunk.type === 'text-delta' && text(chunk.text)) {
          streamState.text += chunk.text;
          streamState.streamedText = true;
          session.turnStats.deltas += 1;
          void Promise.resolve(emit(projectId, {
            key,
            kind: 'stream',
            stream: { t: 'delta', attempt: streamState.attempt, index: inner.index, kind: 'text', turn: streamState.turn, sessionId: session.sessionId, text: chunk.text },
          })).catch(() => {});
        }
        return;
      }
      if (inner.type === 'end') {
        if (streamState.text !== '') {
          session.turnStats.seals += 1;
          void Promise.resolve(emit(projectId, {
            key,
            kind: 'stream',
            stream: { t: 'seal', seal: true, attempt: streamState.attempt, turn: streamState.turn, kind: 'text', sessionId: session.sessionId, text: streamState.text },
          })).catch(() => {});
        }
        if (streamState.thought !== '') {
          session.turnStats.seals += 1;
          void Promise.resolve(emit(projectId, {
            key,
            kind: 'stream',
            stream: { t: 'seal', seal: true, attempt: streamState.attempt, turn: streamState.turn, kind: 'thought', sessionId: session.sessionId, text: streamState.thought },
          })).catch(() => {});
        }
        streamState.text = '';
      }
      return;
    }

    // DSH `follow()` wraps durable events as `{ type: 'event', event: { type, data, seq, time } }`.
    const event = frame.type === 'event' && frame.event && typeof frame.event === 'object' ? frame.event : frame;
    const data = event.data && typeof event.data === 'object' ? event.data : {};

    if (event.type === 'tool/call') {
      const mapped = mapToolCallForUi(data.name, parseToolArgs(data.arguments));
      void Promise.resolve(emit(projectId, {
        key,
        kind: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: data.callId,
          title: mapped.title,
          toolName: mapped.toolName,
          kind: mapped.kind,
          status: 'in_progress',
          rawInput: mapped.rawInput,
        },
      })).catch(() => {});
      return;
    }

    if (event.type === 'tool/result') {
      const msg = data.message && typeof data.message === 'object' ? data.message : {};
      const content = convertToolContent(msg.content);
      const rawOutput = content.map(item => item?.content?.text ?? '').filter(Boolean).join('\n').slice(0, 1200);
      void Promise.resolve(emit(projectId, {
        key,
        kind: 'update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: msg.toolCallId,
          status: msg.isError === true ? 'failed' : 'completed',
          content,
          ...(rawOutput ? { rawOutput } : {}),
        },
      })).catch(() => {});
      return;
    }

    if (event.type === 'assistant/message') {
      const msg = data.message && typeof data.message === 'object' ? data.message : {};
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'reasoning' && text(block.text) && !streamState.streamedThought) {
          void Promise.resolve(emit(projectId, {
            key,
            kind: 'update',
            update: { sessionUpdate: 'agent_thought_chunk', messageId: msg.id, content: { type: 'text', text: block.text } },
          })).catch(() => {});
        } else if (block.type === 'text' && text(block.text)) {
          session.turnStats.textCommits += 1;
          // Always emit the committed paragraph so `LocalAgentTurn.claimAttempt`
          // takes over the streamed row and `reduceTranscript` closes `正在思考`.
          void Promise.resolve(emit(projectId, {
            key,
            kind: 'update',
            update: { sessionUpdate: 'agent_message_chunk', messageId: msg.id, content: { type: 'text', text: block.text } },
          })).catch(() => {});
        }
      }
      streamState.streamedText = false;
      if (data.usage !== undefined) {
        try {
          const liveSession = ctx.sessions?.get?.(session.sessionId);
          const size = liveSession?.requestContext?.()?.contextWindow;
          const meter = ctx.get?.('tokenMeter');
          if (typeof size === 'number' && size > 0 && meter) {
            const used = meter.measure(liveSession)?.totalTokens;
            if (typeof used === 'number') {
              void Promise.resolve(emit(projectId, {
                key,
                kind: 'update',
                update: { sessionUpdate: 'usage_update', used, size },
              })).catch(() => {});
            }
          }
        } catch { /* usage is advisory */ }
      }
      return;
    }

    if (event.type === 'turn/end') {
      const reason = data.stopReason === 'cancelled' || session.inflight?.cancelled ? 'cancelled' : 'end_turn';
      settleTurn(projectId, session, { ok: true, stopReason: reason });
      return;
    }

    if (event.type === 'turn/error' || event.type === 'turn/aborted') {
      const cancelled = event.type === 'turn/aborted' || session.inflight?.cancelled;
      if (cancelled) {
        settleTurn(projectId, session, { ok: true, stopReason: 'cancelled' });
      } else {
        settleTurn(projectId, session, { ok: false, error: String(data.error ?? data.message ?? event.type) });
      }
    }
  }

  function ensureFollow(projectState, session) {
    if (session.followPromise) return;
    const controller = new AbortController();
    session.followAbort = controller;
    const streamState = { turn: -1, attempt: -1, text: '', thought: '', streamedText: false, streamedThought: false };
    session.followPromise = (async () => {
      try {
        const iterable = ctx.sessionController.follow(
          { address: { kind: 'session', sessionId: session.sessionId }, assistantStream: true },
          controller.signal,
        );
        for await (const frame of iterable) {
          if (controller.signal.aborted || closed) break;
          await handleFollowFrame(projectState, session, frame, streamState);
        }
      } catch (error) {
        if (!controller.signal.aborted && !closed) {
          const reason = String(error?.code ?? error?.message ?? error).slice(0, 120);
          void log?.('native-follow-error', { projectId: projectState.projectId, conversation: session.conversation, reason });
          settleTurn(projectState.projectId, session, { ok: false, error: reason });
        }
      } finally {
        if (session.followAbort === controller) {
          session.followAbort = undefined;
          session.followPromise = undefined;
        }
      }
    })();
  }

  async function sessionExists(sessionId) {
    if (!text(sessionId) || typeof ctx.sessionController.projections !== 'function') return false;
    try {
      const res = await ctx.sessionController.projections({ sessionId }, new AbortController().signal);
      return res !== null && res !== undefined;
    } catch {
      return false;
    }
  }

  async function adoptDefaultSelection(projectId, session) {
    let selection;
    try { selection = defaultSelection(); } catch { return; }
    if (!selection || !text(selection.provider) || !text(selection.model)) return;
    try {
      await ctx.sessionController.selectModel({
        sessionId: session.sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(text(selection.reasoningEffort) ? { reasoningEffort: selection.reasoningEffort } : {}),
      });
      session.model = { provider: selection.provider, model: selection.model };
      session.reasoningEffort = text(selection.reasoningEffort) ? selection.reasoningEffort : undefined;
      void log?.('native-default-model', { projectId, conversation: session.conversation, provider: selection.provider, model: selection.model });
    } catch (error) {
      void log?.('native-default-model-failed', { projectId, reason: String(error?.code ?? error?.message ?? error).slice(0, 80) });
    }
  }

  async function ensure(projectId, conversation) {
    if (closed) throw failure('OFFICIAL_AGENT_CLOSED');
    const projectState = projectStateOf(projectId);
    const session = sessionStateOf(projectState, conversation);
    if (session.ready) return await session.ready;

    session.ready = (async () => {
      const project = await verifier(projectId);
      if (!project || !text(project.path)) throw failure('OFFICIAL_AGENT_UNAVAILABLE', 'project has no folder');
      projectState.projectPath = project.path;

      try { await prepareProject?.(projectId, project.path); }
      catch (error) { void log?.('prepare-project-failed', { projectId, reason: String(error?.code ?? error).slice(0, 60) }); }

      const known = (typeof store.getSession === 'function' ? store.getSession(projectId, session.conversation) : undefined)
        ?? (session.conversation === '' ? store.get(projectId) : undefined);

      if (known?.sessionId && await sessionExists(known.sessionId)) {
        session.sessionId = known.sessionId;
        session.reopened = true;
        sessionProjects.set(session.sessionId, { projectId, path: project.path, conversation: session.conversation });
        ensureFollow(projectState, session);
        void log?.('native-session', { projectId, conversation: session.conversation, resumed: true });
        return session;
      }

      let createParams = { cwd: project.path, agentPreset };
      try {
        const registry = ctx.get?.('workspaceRegistry');
        const rootDir = dirname(project.path);
        if (registry && typeof registry.create === 'function' && text(rootDir)) {
          const workspace = await registry.create(rootDir);
          if (text(workspace?.id)) createParams = { workspaceId: workspace.id, agentPreset };
        }
      } catch (error) {
        void log?.('native-workspace-fallback', { projectId, reason: String(error?.code ?? error?.message ?? error).slice(0, 80) });
      }

      const created = await ctx.sessionController.create(createParams);
      if (!created || !text(created.sessionId)) throw failure('OFFICIAL_AGENT_UNAVAILABLE', 'sessionController returned no sessionId');
      session.sessionId = created.sessionId;
      session.reopened = false;
      sessionProjects.set(session.sessionId, { projectId, path: project.path, conversation: session.conversation });
      if (typeof store.setSession === 'function') store.setSession(projectId, session.conversation, { sessionId: created.sessionId, cwd: project.path });
      else store.set(projectId, { sessionId: created.sessionId, cwd: project.path });

      await adoptDefaultSelection(projectId, session);
      ensureFollow(projectState, session);
      void log?.('native-session', { projectId, conversation: session.conversation, created: true, agentPreset: created.agentPreset ?? agentPreset });
      return session;
    })();

    try {
      return await session.ready;
    } catch (error) {
      session.ready = undefined;
      throw error;
    }
  }

  return Object.freeze({
    /** Check whether a live DSH Agent belongs to an active OpenFilm native session. */
    isProjectAgent(agent) {
      const sid = agent?.session?.id;
      return Boolean(typeof sid === 'string' && sessionProjects.has(sid));
    },

    /** Resolve the bound project `{ projectId, path }` for a live DSH Agent. */
    projectOfAgent(agent) {
      const sid = agent?.session?.id;
      return typeof sid === 'string' ? sessionProjects.get(sid) : undefined;
    },

    async send(projectId, { conversation, key, turnId, text: promptText, images } = {}) {
      if (typeof promptText !== 'string' || promptText.length > 200000) throw failure('OFFICIAL_AGENT_INPUT', 'bad prompt');
      const projectState = projectStateOf(projectId);
      const session = await ensure(projectId, conversation);
      if (session.inflight) throw failure('OFFICIAL_AGENT_BUSY', 'a turn is already running');

      session.key = text(key) ? key : session.key;
      session.lastUsed = Date.now();
      session.turnStats = { deltas: 0, seals: 0, syncs: 0, textCommits: 0 };

      const content = [];
      for (const image of (Array.isArray(images) ? images : []).slice(0, 8)) {
        if (text(image?.data) && text(image?.mediaType) && image.mediaType.startsWith('image/')) {
          content.push({ type: 'image', mediaType: image.mediaType, data: image.data, ...(text(image.name) ? { name: image.name } : {}) });
        }
      }
      if (promptText.trim()) content.push({ type: 'text', text: promptText });
      if (content.length === 0) throw failure('OFFICIAL_AGENT_INPUT', 'empty prompt');

      ensureFollow(projectState, session);
      const requestId = randomUUID();
      const turnDone = new Promise((resolve, reject) => {
        session.inflight = { turnId, cancelled: false, resolve, reject };
      });

      try {
        void log?.('native-prompt-start', { projectId, conversation: session.conversation, sessionId: session.sessionId });
        await ctx.sessionController.prompt(
          { requestId, sessionId: session.sessionId, mode: 'queue', content },
          new AbortController().signal,
        );
        const outcome = await turnDone;
        const stopReason = outcome?.stopReason === 'cancelled' ? 'cancelled' : 'end_turn';
        void log?.('native-prompt-done', { projectId, conversation: session.conversation, stopReason, deltas: session.turnStats.deltas, textCommits: session.turnStats.textCommits });
        if (await emit(projectId, { key: session.key, kind: 'done', turnId, ok: true, stopReason }) === false) {
          throw failure('OFFICIAL_AGENT_STREAM_LOST', 'no live event stream accepted the terminal event');
        }
        return { ok: true, stopReason };
      } catch (error) {
        session.inflight = undefined;
        if (error?.code === 'OFFICIAL_AGENT_STREAM_LOST') throw error;
        const reason = String(error?.code ?? error?.message ?? error).slice(0, 300);
        void log?.('native-prompt-failed', { projectId, reason: reason.slice(0, 120) });
        // Turn/model failures (e.g. 429 rate limit, cooldown) are surfaced inside
        // the chat transcript via `done: { ok: false, error }` — returning cleanly
        // avoids a redundant HTTP 503 global error banner at the bottom of the screen.
        await emit(projectId, { key: session.key, kind: 'done', turnId, ok: false, error: reason }).catch(() => {});
        return { ok: false, error: reason };
      }
    },

    async cancel(projectId, conversation) {
      const projectState = projects.get(projectId);
      const session = projectState ? sessionStateOf(projectState, conversation) : undefined;
      if (!projectState || !session || !session.sessionId || !session.inflight) throw failure('OFFICIAL_AGENT_NOT_RUNNING');
      session.inflight.cancelled = true;
      await ctx.sessionController.cancel({ sessionId: session.sessionId });
      return { ok: true };
    },

    async modelCatalog(projectId, conversation) {
      await ensure(projectId, conversation);
      const catalog = await ctx.sessionController.modelCatalog();
      if (!catalog || !Array.isArray(catalog.groups) || catalog.groups.length === 0) {
        throw failure('OFFICIAL_AGENT_MODEL_UNAVAILABLE', 'no models advertised');
      }
      return catalog;
    },

    async selectModel(projectId, selection, conversation) {
      const session = await ensure(projectId, conversation);
      const provider = selection?.provider;
      const model = selection?.model;
      if (!text(provider) || !text(model)) throw failure('OFFICIAL_AGENT_INPUT', 'invalid model');
      await ctx.sessionController.selectModel({
        sessionId: session.sessionId,
        provider,
        model,
        ...(text(session.reasoningEffort) ? { reasoningEffort: session.reasoningEffort } : {}),
      });
      session.model = { provider, model };
      return { ok: true };
    },

    async thinkingOption(projectId, conversation) {
      const session = await ensure(projectId, conversation);
      const catalog = await ctx.sessionController.modelCatalog();
      const target = session.model ?? catalog?.default;
      const group = catalog?.groups?.find(g => g.id === target?.provider);
      const model = group?.models?.find(m => m.id === target?.model);
      const efforts = model?.reasoning?.efforts;
      if (!Array.isArray(efforts) || efforts.length === 0) return null;
      return {
        id: 'thinking',
        name: 'Thinking',
        category: 'thought_level',
        type: 'select',
        ...(text(session.reasoningEffort ?? model?.reasoning?.defaultEffort) ? { currentValue: session.reasoningEffort ?? model.reasoning.defaultEffort } : {}),
        options: efforts.map(e => typeof e === 'string' ? { value: e, name: e } : { value: e.id ?? e.value, name: e.name ?? e.id ?? e.value }),
      };
    },

    async selectThinking(projectId, value, conversation) {
      const session = await ensure(projectId, conversation);
      if (!text(value)) throw failure('OFFICIAL_AGENT_INPUT', 'invalid thinking effort');
      const catalog = await ctx.sessionController.modelCatalog();
      const target = session.model ?? catalog?.default;
      if (!text(target?.provider) || !text(target?.model)) throw failure('OFFICIAL_AGENT_MODEL_UNAVAILABLE', 'no active model');
      await ctx.sessionController.selectModel({
        sessionId: session.sessionId,
        provider: target.provider,
        model: target.model,
        reasoningEffort: value,
      });
      session.reasoningEffort = value;
      return { ok: true };
    },

    answerPermission() {
      return { ok: false };
    },

    async reset(projectId) {
      const projectState = projects.get(projectId);
      if (!projectState) return { ok: true };
      projects.delete(projectId);
      for (const session of projectState.sessions.values()) {
        stopFollow(session);
        if (session.sessionId) sessionProjects.delete(session.sessionId);
        if (session.inflight) settleTurn(projectId, session, { ok: true, stopReason: 'cancelled' });
      }
      return { ok: true };
    },

    activeKey(projectId, conversation) {
      const projectState = projects.get(projectId);
      if (!projectState) return null;
      return sessionStateOf(projectState, conversation).key ?? null;
    },

    diagnose(projectId, conversation) {
      const projectState = projects.get(projectId);
      const session = projectState ? sessionStateOf(projectState, conversation) : undefined;
      return {
        driver: 'native',
        agentPreset,
        sessionId: session?.sessionId ?? null,
        key: session?.key ?? null,
        inflight: Boolean(session?.inflight),
        model: session?.model ? `${session.model.provider}/${session.model.model}` : null,
        effort: session?.reasoningEffort ?? null,
        stream: {
          connected: Boolean(session?.followPromise),
          deltas: session?.turnStats?.deltas ?? 0,
          seals: session?.turnStats?.seals ?? 0,
          syncs: session?.turnStats?.syncs ?? 0,
          textCommits: session?.turnStats?.textCommits ?? 0,
        },
        sessions: projectState ? [...projectState.sessions.values()].map(item => ({
          conversation: item.conversation,
          sessionId: item.sessionId ?? null,
          resumed: item.reopened === true,
          inflight: Boolean(item.inflight),
          lastUsed: item.lastUsed,
        })) : [],
      };
    },

    sessionState(projectId, conversation) {
      const projectState = projects.get(projectId);
      if (!projectState) return undefined;
      const session = sessionStateOf(projectState, conversation);
      if (!session.sessionId) return undefined;
      const snapshot = this.diagnose(projectId, conversation);
      return {
        sessionId: session.sessionId,
        resumed: session.reopened === true,
        model: snapshot.model,
        effort: snapshot.effort,
      };
    },

    async close() {
      closed = true;
      offError?.();
      offStatus?.();
      for (const projectState of projects.values()) {
        for (const session of projectState.sessions.values()) stopFollow(session);
      }
      projects.clear();
      sessionProjects.clear();
    },
  });
}
