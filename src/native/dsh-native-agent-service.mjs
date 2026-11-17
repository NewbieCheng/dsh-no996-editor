// In-process native DSH SessionController driver for the OpenFilm panel.
//
// Replaces the `dsh --profile acp` child process, `acp-stream-tap` TCP socket,
// and MCP loopback server with direct calls to `ctx.sessionController` inside
// the Host process. Each conversation opens a real DSH Session bound to the
// `openfilm-video-editing` preset (`cwd = project.path`).
import { randomUUID } from 'node:crypto';
import { parseToolArgs, mapToolCallForUi, convertToolContent } from './dsh-event-map.mjs';

const PROJECT_ID = /^[A-Za-z0-9_-]{6,40}$/;
const CONVERSATION = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_PRESET = 'openfilm-video-editing';

/** Chinese labels for DSH effort ids. Unknown ids stay as-is — never invent tiers. */
const EFFORT_ZH = Object.freeze({
  off: '关闭', none: '关闭', disabled: '关闭', '关闭': '关闭',
  low: '低', '低': '低',
  medium: '中', mid: '中', '中': '中',
  high: '高', '高': '高',
  max: '最高', maximum: '最高', '最高': '最高',
  auto: '自动', '自动': '自动',
  default: '默认', '默认': '默认',
});

const failure = (code, detail) => Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
const text = value => typeof value === 'string' && value.length > 0;
const effortId = value => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return value.id ?? value.value ?? '';
  return '';
};
const effortLabel = (value, providedName) => {
  const id = effortId(value);
  if (!id) return typeof providedName === 'string' && providedName ? providedName : '';
  if (EFFORT_ZH[id]) return EFFORT_ZH[id];
  const lower = id.toLowerCase();
  if (EFFORT_ZH[lower]) return EFFORT_ZH[lower];
  if (typeof providedName === 'string' && providedName) {
    if (EFFORT_ZH[providedName] || EFFORT_ZH[providedName.toLowerCase()]) {
      return EFFORT_ZH[providedName] || EFFORT_ZH[providedName.toLowerCase()];
    }
    if (/[\u4e00-\u9fff]/.test(providedName)) return providedName;
  }
  return providedName || id;
};
const effortIdsOf = model => {
  const efforts = model?.reasoning?.efforts;
  if (!Array.isArray(efforts)) return [];
  return efforts.map(effortId).filter(Boolean);
};

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
      modelSource: undefined,
      lastUsage: undefined,
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

  function emitUsage(projectId, session, used, size) {
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 ||
        typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return false;
    session.lastUsage = { used: Math.round(used), size: Math.round(size) };
    void Promise.resolve(emit(projectId, {
      key: session.key ?? 'dsh-native',
      kind: 'update',
      update: { sessionUpdate: 'usage_update', used: session.lastUsage.used, size: session.lastUsage.size },
    })).catch(() => {});
    return true;
  }

  function applyProjectionUsage(projectId, session, projections) {
    const values = projections?.values ?? projections;
    const pressure = values?.contextPressure;
    if (!pressure || typeof pressure !== 'object') return false;
    const size = pressure.contextWindow;
    const used = pressure.projectedTokens ?? pressure.pressureTokens;
    return emitUsage(projectId, session, used, size);
  }

  async function resolveModelMeta(provider, modelId) {
    if (text(provider) && text(modelId) && typeof ctx.llm?.resolveModelInfo === 'function') {
      try {
        const info = await ctx.llm.resolveModelInfo(provider, modelId);
        if (info && typeof info === 'object') return info;
      } catch { /* fall back to catalog */ }
    }
    return undefined;
  }

  function decodeModelValue(raw) {
    if (!text(raw) || raw.length > 512) return undefined;
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      if (Array.isArray(parsed) && parsed.length === 2 && text(parsed[0]) && text(parsed[1])) {
        return { provider: parsed[0], model: parsed[1] };
      }
    } catch { /* not a base64url model value */ }
    return undefined;
  }

  async function contextWindowOf(session, overrideTarget) {
    try {
      const catalog = await ctx.sessionController.modelCatalog?.();
      const target = overrideTarget ?? session?.model ?? catalog?.default;
      if (text(target?.provider) && text(target?.model)) {
        const info = await resolveModelMeta(target.provider, target.model);
        const resolvedSize = info?.context?.contextWindow ?? info?.contextWindow;
        if (typeof resolvedSize === 'number' && resolvedSize > 0) return resolvedSize;
      }
      const group = catalog?.groups?.find(g => g.id === target?.provider);
      const model = group?.models?.find(m => m.id === target?.model);
      const size = model?.context?.contextWindow ?? model?.contextWindow ?? model?.limits?.contextWindow ?? session?.lastUsage?.size;
      return typeof size === 'number' && size > 0 ? size : undefined;
    } catch {
      return session?.lastUsage?.size;
    }
  }

  async function syncUsage(projectId, session, fallbackUsage) {
    if (text(session?.sessionId)) {
      try {
        if (typeof ctx.sessionController.projections === 'function') {
          const snap = await ctx.sessionController.projections({ sessionId: session.sessionId }, new AbortController().signal);
          if (applyProjectionUsage(projectId, session, snap)) return true;
          const values = snap?.values ?? snap;
          const pressure = values?.contextPressure;
          const used = pressure?.projectedTokens ?? pressure?.pressureTokens;
          if (typeof used === 'number' && used >= 0) {
            const size = await contextWindowOf(session);
            if (typeof size === 'number' && size > 0) return emitUsage(projectId, session, used, size);
          }
        }
      } catch { /* fall through to fallbackUsage */ }
    }
    if (fallbackUsage && typeof fallbackUsage === 'object') {
      const used = fallbackUsage.inputTokens ?? fallbackUsage.promptTokens ?? fallbackUsage.totalTokens;
      if (typeof used === 'number' && used >= 0) {
        const size = await contextWindowOf(session);
        if (typeof size === 'number' && size > 0) return emitUsage(projectId, session, used, size);
      }
    }
    // Last resort so the ring is not stuck on "发一条消息后才有": publish the
    // model's window even when projections omit contextPressure or no turn ran yet.
    const size = await contextWindowOf(session);
    if (typeof size === 'number' && size > 0) {
      return emitUsage(projectId, session, session?.lastUsage?.used ?? 0, size);
    }
    return false;
  }

  function replayUsage(projectId, session) {
    if (!session?.lastUsage) return false;
    return emitUsage(projectId, session, session.lastUsage.used, session.lastUsage.size);
  }

  function persistSelection(projectId, session) {
    if (!text(session?.sessionId) || !session.model) return;
    const selection = {
      provider: session.model.provider,
      model: session.model.model,
      ...(text(session.reasoningEffort) ? { reasoningEffort: session.reasoningEffort } : {}),
    };
    try {
      if (typeof store.setSelection === 'function') store.setSelection(projectId, session.conversation, selection);
      else if (typeof store.setSession === 'function') {
        store.setSession(projectId, session.conversation, { sessionId: session.sessionId, selection });
      }
    } catch { /* mapping loss only costs a default on next reopen */ }
  }

  function selectionFromUnknown(raw, effortFallback) {
    if (!raw || typeof raw !== 'object') return undefined;
    const provider = raw.provider ?? raw.providerId;
    const model = raw.model ?? raw.modelId ?? raw.id;
    if (!text(provider) || !text(model)) return undefined;
    const effort = raw.reasoningEffort ?? raw.effort ?? effortFallback;
    return {
      provider,
      model,
      ...(text(effort) ? { reasoningEffort: effort } : {}),
    };
  }

  function readLiveSelection(sessionId) {
    if (!text(sessionId)) return undefined;
    // Prefer the in-memory Session table; fall back to sessionController.list —
    // some Host builds refuse ctx.get('sessions') without an inject declaration.
    try {
      if (typeof ctx.get === 'function') {
        const live = ctx.get('sessions')?.get?.(sessionId);
        const hit = selectionFromUnknown(
          live?.selectedModel ?? live?.modelSelection ?? live?.selection ?? live?.model,
          live?.reasoningEffort,
        );
        if (hit) return { ...hit, source: 'live' };
      }
    } catch { /* try list() */ }
    return undefined;
  }

  async function readListedSelection(sessionId) {
    if (!text(sessionId) || typeof ctx.sessionController?.list !== 'function') return undefined;
    try {
      const listed = await ctx.sessionController.list({}, AbortSignal.timeout(1500));
      const rows = Array.isArray(listed?.sessions) ? listed.sessions : (Array.isArray(listed) ? listed : []);
      const row = rows.find(item => item?.id === sessionId || item?.sessionId === sessionId);
      if (!row) return undefined;
      const hit = selectionFromUnknown(
        row.selectedModel ?? row.modelSelection ?? row.selection ?? row.model,
        row.reasoningEffort ?? row.effort,
      );
      return hit ? { ...hit, source: 'list' } : undefined;
    } catch {
      return undefined;
    }
  }

  function applySelection(session, selection, source) {
    if (!selection || !text(selection.provider) || !text(selection.model)) return false;
    session.model = { provider: selection.provider, model: selection.model };
    session.reasoningEffort = text(selection.reasoningEffort) ? selection.reasoningEffort : undefined;
    session.modelSource = source;
    return true;
  }

  async function hydrateSelection(projectId, session) {
    // Live / list win over our store; store wins over leaving model unset
    // (which would fall through to catalog.default and lie in the menu).
    const live = readLiveSelection(session.sessionId) ?? await readListedSelection(session.sessionId);
    if (live && applySelection(session, live, live.source || 'live')) {
      persistSelection(projectId, session);
      void log?.('native-model-hydrate', {
        projectId,
        conversation: session.conversation,
        source: live.source || 'live',
        model: `${live.provider}/${live.model}`,
        effort: live.reasoningEffort ?? null,
      });
      return;
    }
    if (session.model) return;
    const known = (typeof store.getSession === 'function' ? store.getSession(projectId, session.conversation) : undefined)
      ?? (session.conversation === '' ? store.get(projectId) : undefined);
    if (known?.selection && applySelection(session, known.selection, 'store')) {
      // Re-apply onto the live Session so the agent and the menu cannot diverge
      // (menu used to show catalog.default while the Session kept GPT/etc.).
      try {
        await ctx.sessionController.selectModel({
          sessionId: session.sessionId,
          provider: known.selection.provider,
          model: known.selection.model,
          ...(text(known.selection.reasoningEffort) ? { reasoningEffort: known.selection.reasoningEffort } : {}),
        });
      } catch (error) {
        void log?.('native-model-reapply-failed', {
          projectId,
          reason: String(error?.code ?? error?.message ?? error).slice(0, 80),
        });
      }
      void log?.('native-model-hydrate', {
        projectId,
        conversation: session.conversation,
        source: 'store',
        model: `${known.selection.provider}/${known.selection.model}`,
        effort: known.selection.reasoningEffort ?? null,
      });
    }
  }

  async function resolveModelEntry(session, overrideTarget) {
    const catalog = await ctx.sessionController.modelCatalog();
    const target = overrideTarget ?? session?.model ?? catalog?.default;
    const group = catalog?.groups?.find(g => g.id === target?.provider);
    let model = group?.models?.find(m => m.id === target?.model);
    if (text(target?.provider) && text(target?.model) && (!model?.reasoning || !Array.isArray(model.reasoning.efforts) || model.reasoning.efforts.length === 0)) {
      const resolved = await resolveModelMeta(target.provider, target.model);
      if (resolved?.reasoning && Array.isArray(resolved.reasoning.efforts) && resolved.reasoning.efforts.length > 0) {
        model = { ...(model ?? { id: target.model, name: resolved.name ?? target.model }), reasoning: resolved.reasoning };
      }
    }
    return { catalog, target, group, model };
  }

  function buildThinkingOption(session, model, { isPreview = false } = {}) {
    const efforts = model?.reasoning?.efforts;
    if (!Array.isArray(efforts) || efforts.length === 0) return null;
    const options = [];
    for (const entry of efforts) {
      const value = effortId(entry);
      if (!value) continue;
      const provided = typeof entry === 'string' ? undefined : (entry?.name ?? entry?.label);
      options.push({ value, name: effortLabel(value, provided) });
    }
    if (options.length === 0) return null;
    const allowed = options.map(o => o.value);
    const candidate = isPreview
      ? (model?.reasoning?.defaultEffort ?? allowed[0])
      : (session?.reasoningEffort ?? model?.reasoning?.defaultEffort);
    const current = text(candidate) && allowed.includes(candidate)
      ? candidate
      : (text(model?.reasoning?.defaultEffort) && allowed.includes(model.reasoning.defaultEffort) ? model.reasoning.defaultEffort : allowed[0]);
    return {
      id: 'thinking',
      name: '思考强度',
      category: 'thought_level',
      type: 'select',
      ...(text(current) ? { currentValue: current } : {}),
      options,
    };
  }

  async function handleFollowFrame(projectState, session, frame, streamState) {
    const { projectId } = projectState;
    const key = session.key ?? 'dsh-native';

    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'snapshot') {
      applyProjectionUsage(projectId, session, frame.projections);
      return;
    }

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
      void syncUsage(projectId, session, data.usage);
      return;
    }

    if (event.type === 'compaction/start') {
      const compactId = `compact:${event.seq ?? Date.now()}`;
      streamState.activeCompactId = compactId;
      void Promise.resolve(emit(projectId, {
        key,
        kind: 'update',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: compactId,
          title: 'read',
          toolName: 'compaction',
          kind: 'read',
          status: 'in_progress',
          rawInput: { path: '自动压缩历史上下文…' },
        },
      })).catch(() => {});
      return;
    }

    if (event.type === 'compaction/end') {
      const compactId = streamState.activeCompactId ?? `compact:${event.seq ?? Date.now()}`;
      streamState.activeCompactId = undefined;
      void Promise.resolve(emit(projectId, {
        key,
        kind: 'update',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: compactId,
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: '上下文已自动压缩' } }],
          rawOutput: '上下文已自动压缩',
        },
      })).catch(() => {});
      void syncUsage(projectId, session);
      return;
    }

    if (event.type === 'turn/end') {
      void syncUsage(projectId, session);
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

  function workspaceIdOf(value) {
    if (!value || typeof value !== 'object') return undefined;
    if (text(value.id)) return value.id;
    if (text(value.workspaceId)) return value.workspaceId;
    const nested = value.workspace;
    if (nested && typeof nested === 'object') {
      if (text(nested.id)) return nested.id;
      if (text(nested.workspaceId)) return nested.workspaceId;
    }
    return undefined;
  }

  function pathMatchesFilm(candidate, filmPath) {
    if (!text(candidate) || !text(filmPath)) return false;
    const a = candidate.replace(/[\\/]+$/, '').toLowerCase();
    const b = filmPath.replace(/[\\/]+$/, '').toLowerCase();
    return a === b;
  }

  /**
   * Look up an existing DSH workspace for a film folder without creating one.
   * Film sessions run under `{ cwd: project.path, agentPreset }` so uninstalling
   * or switching plugins never leaves orphaned folders in DSH's main Workspace list.
   */
  async function resolveFilmWorkspaceId(filmPath) {
    if (!text(filmPath) || typeof ctx.get !== 'function') return undefined;
    const registry = ctx.get('workspaceRegistry');
    if (!registry || typeof registry.list !== 'function') return undefined;

    try {
      const listed = await registry.list();
      const rows = Array.isArray(listed) ? listed
        : (Array.isArray(listed?.workspaces) ? listed.workspaces : []);
      for (const row of rows) {
        const path = row?.path ?? row?.root ?? row?.cwd ?? row?.workspace?.path;
        if (!pathMatchesFilm(path, filmPath)) continue;
        const id = workspaceIdOf(row) ?? workspaceIdOf(row?.workspace);
        if (text(id)) return id;
      }
    } catch { /* fall back to { cwd: filmPath } */ }

    return undefined;
  }

  async function adoptDefaultSelection(projectId, session, { persist = true } = {}) {
    if (session.model) return;
    let selection;
    try { selection = defaultSelection(); } catch { return; }
    if (!selection || !text(selection.provider) || !text(selection.model)) return;
    if (!text(session.sessionId)) {
      applySelection(session, selection, 'default');
      return;
    }
    try {
      await ctx.sessionController.selectModel({
        sessionId: session.sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(text(selection.reasoningEffort) ? { reasoningEffort: selection.reasoningEffort } : {}),
      });
      applySelection(session, selection, 'default');
      if (persist) persistSelection(projectId, session);
      void log?.('native-default-model', { projectId, conversation: session.conversation, provider: selection.provider, model: selection.model });
    } catch (error) {
      void log?.('native-default-model-failed', { projectId, reason: String(error?.code ?? error?.message ?? error).slice(0, 80) });
    }
  }

  async function peekSession(projectId, conversation) {
    if (closed) throw failure('OFFICIAL_AGENT_CLOSED');
    const projectState = projectStateOf(projectId);
    const session = sessionStateOf(projectState, conversation);
    if (session.ready) {
      try { await session.ready; } catch { /* fall back to store/default */ }
    }
    if (!session.sessionId) {
      const known = (typeof store.getSession === 'function' ? store.getSession(projectId, session.conversation) : undefined)
        ?? (session.conversation === '' ? store.get(projectId) : undefined);
      if (known?.sessionId && await sessionExists(known.sessionId)) {
        session.sessionId = known.sessionId;
        session.reopened = true;
      } else if (!session.model && known?.selection) {
        applySelection(session, known.selection, 'store');
      }
    }
    if (session.sessionId && !session.model) {
      await hydrateSelection(projectId, session);
    }
    if (!session.model) {
      await adoptDefaultSelection(projectId, session, { persist: false });
    }
    return session;
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
        await hydrateSelection(projectId, session);
        ensureFollow(projectState, session);
        void syncUsage(projectId, session);
        void log?.('native-session', {
          projectId,
          conversation: session.conversation,
          resumed: true,
          model: session.model ? `${session.model.provider}/${session.model.model}` : null,
          effort: session.reasoningEffort ?? null,
          modelSource: session.modelSource ?? null,
        });
        return session;
      }

      // Bind the film folder itself — never its parent `Projects` directory.
      // Using dirname() made every film under different `…/Projects` trees show
      // up as duplicate side-bar folders all named "Projects".
      let createParams = { cwd: project.path, agentPreset };
      try {
        const workspaceId = await resolveFilmWorkspaceId(project.path);
        if (text(workspaceId)) {
          createParams = { workspaceId, agentPreset };
          void log?.('native-workspace', { projectId, workspaceId, path: project.path });
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

      if (session.model) {
        try {
          await ctx.sessionController.selectModel({
            sessionId: session.sessionId,
            provider: session.model.provider,
            model: session.model.model,
            ...(text(session.reasoningEffort) ? { reasoningEffort: session.reasoningEffort } : {}),
          });
          persistSelection(projectId, session);
        } catch (error) {
          void log?.('native-preselected-model-failed', { projectId, reason: String(error?.code ?? error?.message ?? error).slice(0, 80) });
        }
      } else {
        await adoptDefaultSelection(projectId, session);
      }
      ensureFollow(projectState, session);
      void syncUsage(projectId, session);
      void log?.('native-session', {
        projectId,
        conversation: session.conversation,
        created: true,
        agentPreset: created.agentPreset ?? agentPreset,
        model: session.model ? `${session.model.provider}/${session.model.model}` : null,
        effort: session.reasoningEffort ?? null,
        modelSource: session.modelSource ?? null,
      });
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

    async modelCatalog(projectId, conversation, modelValue) {
      const session = await peekSession(projectId, conversation);
      const catalog = await ctx.sessionController.modelCatalog();
      if (!catalog || !Array.isArray(catalog.groups) || catalog.groups.length === 0) {
        throw failure('OFFICIAL_AGENT_MODEL_UNAVAILABLE', 'no models advertised');
      }
      const override = decodeModelValue(modelValue);
      if (override && catalog.groups.some(g => g.id === override.provider && g.models?.some(m => m.id === override.model))) {
        return { ...catalog, default: override };
      }
      // Prefer this conversation's selection so the menu currentValue matches the
      // Session, not the Host-wide default.
      if (session.model?.provider && session.model?.model) {
        return { ...catalog, default: { provider: session.model.provider, model: session.model.model } };
      }
      return catalog;
    },

    async selectModel(projectId, selection, conversation) {
      const session = await peekSession(projectId, conversation);
      const provider = selection?.provider;
      const modelId = selection?.model;
      if (!text(provider) || !text(modelId)) throw failure('OFFICIAL_AGENT_INPUT', 'invalid model');
      const catalog = await ctx.sessionController.modelCatalog();
      const group = catalog?.groups?.find(g => g.id === provider);
      let model = group?.models?.find(m => m.id === modelId);
      if (!model?.reasoning || !Array.isArray(model.reasoning.efforts) || model.reasoning.efforts.length === 0) {
        const resolved = await resolveModelMeta(provider, modelId);
        if (resolved?.reasoning && Array.isArray(resolved.reasoning.efforts) && resolved.reasoning.efforts.length > 0) {
          model = { ...(model ?? { id: modelId, name: resolved.name ?? modelId }), reasoning: resolved.reasoning };
        }
      }
      const allowed = effortIdsOf(model);
      let effort = session.reasoningEffort;
      if (text(effort) && allowed.length > 0 && !allowed.includes(effort)) {
        effort = text(model?.reasoning?.defaultEffort) && allowed.includes(model.reasoning.defaultEffort)
          ? model.reasoning.defaultEffort
          : undefined;
      }
      if (text(session.sessionId)) {
        await ctx.sessionController.selectModel({
          sessionId: session.sessionId,
          provider,
          model: modelId,
          ...(text(effort) ? { reasoningEffort: effort } : {}),
        });
      }
      session.model = { provider, model: modelId };
      session.reasoningEffort = text(effort) ? effort : undefined;
      session.modelSource = 'selected';
      persistSelection(projectId, session);
      if (session.key) void syncUsage(projectId, session);
      void log?.('native-select-model', {
        projectId,
        conversation: session.conversation,
        model: `${provider}/${modelId}`,
        effort: session.reasoningEffort ?? null,
        efforts: allowed,
      });
      return { ok: true };
    },

    async thinkingOption(projectId, conversation, modelValue) {
      const session = await peekSession(projectId, conversation);
      const override = decodeModelValue(modelValue);
      const { model } = await resolveModelEntry(session, override);
      const isPreview = Boolean(override && (override.provider !== session?.model?.provider || override.model !== session?.model?.model));
      return buildThinkingOption(session, model, { isPreview });
    },

    async selectThinking(projectId, value, conversation) {
      const session = await peekSession(projectId, conversation);
      if (!text(value)) throw failure('OFFICIAL_AGENT_INPUT', 'invalid thinking effort');
      const { target, model } = await resolveModelEntry(session);
      if (!text(target?.provider) || !text(target?.model)) throw failure('OFFICIAL_AGENT_MODEL_UNAVAILABLE', 'no active model');
      const allowed = effortIdsOf(model);
      // Refuse inventing a tier the model did not advertise.
      if (allowed.length > 0 && !allowed.includes(value)) {
        throw failure('OFFICIAL_AGENT_INPUT', `thinking effort not supported: ${value}`);
      }
      if (text(session.sessionId)) {
        await ctx.sessionController.selectModel({
          sessionId: session.sessionId,
          provider: target.provider,
          model: target.model,
          reasoningEffort: value,
        });
      }
      session.model = { provider: target.provider, model: target.model };
      session.reasoningEffort = value;
      session.modelSource = session.modelSource ?? 'selected';
      persistSelection(projectId, session);
      void log?.('native-select-thinking', {
        projectId,
        conversation: session.conversation,
        model: `${target.provider}/${target.model}`,
        effort: value,
        efforts: allowed,
      });
      return { ok: true };
    },

    /**
     * Bind the page's agent key and push current context usage before the first
     * prompt. Existing stored sessions are resumed; blank conversations stay in
     * memory until the first prompt so opening a panel never creates ghost sessions.
     */
    async attach(projectId, conversation, { key } = {}) {
      if (closed) throw failure('OFFICIAL_AGENT_CLOSED');
      const projectState = projectStateOf(projectId);
      const session = sessionStateOf(projectState, conversation);
      const project = await verifier(projectId);
      if (!project || !text(project.path)) throw failure('OFFICIAL_AGENT_UNAVAILABLE', 'project has no folder');
      projectState.projectPath = project.path;

      const known = (typeof store.getSession === 'function' ? store.getSession(projectId, session.conversation) : undefined)
        ?? (session.conversation === '' ? store.get(projectId) : undefined);

      if (known?.sessionId && await sessionExists(known.sessionId)) {
        await ensure(projectId, conversation);
        if (text(key)) session.key = key;
        await hydrateSelection(projectId, session);
        await syncUsage(projectId, session);
      } else {
        if (text(key)) session.key = key;
        if (!session.model && known?.selection) applySelection(session, known.selection, 'store');
        if (!session.model) await adoptDefaultSelection(projectId, session, { persist: false });
        if (!session.model) {
          try {
            const catalog = await ctx.sessionController.modelCatalog?.();
            if (catalog?.default && text(catalog.default.provider) && text(catalog.default.model)) {
              applySelection(session, catalog.default, 'catalog');
            }
          } catch { /* catalog optional */ }
        }
        await syncUsage(projectId, session);
      }

      // Always re-emit under the page key: an earlier follow snapshot may have
      // published usage under the placeholder `dsh-native` key.
      if (session.lastUsage) replayUsage(projectId, session);
      // EventSource can finish "ready" a tick after the first write; one delayed
      // replay covers that race without waiting on the first user prompt.
      const replayKey = session.key;
      const replayProjectId = projectId;
      setTimeout(() => {
        const currentProject = projects.get(replayProjectId);
        const current = currentProject ? sessionStateOf(currentProject, session.conversation) : undefined;
        if (current?.lastUsage && current.key === replayKey) replayUsage(replayProjectId, current);
      }, 120).unref?.();
      void log?.('native-attach', {
        projectId,
        conversation: session.conversation,
        key: session.key ?? null,
        sessionId: session.sessionId ?? null,
        model: session.model ? `${session.model.provider}/${session.model.model}` : null,
        effort: session.reasoningEffort ?? null,
        modelSource: session.modelSource ?? null,
        usage: session.lastUsage ? { used: session.lastUsage.used, size: session.lastUsage.size } : null,
      });
      return {
        ok: true,
        sessionId: session.sessionId ?? null,
        resumed: session.reopened === true,
        key: session.key ?? null,
        model: session.model ? `${session.model.provider}/${session.model.model}` : null,
        effort: session.reasoningEffort ?? null,
        modelSource: session.modelSource ?? null,
        usage: session.lastUsage ? { used: session.lastUsage.used, size: session.lastUsage.size } : null,
      };
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
      let thinking = null;
      try {
        // Best-effort snapshot of what the menu would show right now (sync path:
        // diagnose must stay fast and never open a Session).
        if (session?.model) {
          thinking = {
            model: `${session.model.provider}/${session.model.model}`,
            effort: session.reasoningEffort ?? null,
            modelSource: session.modelSource ?? null,
          };
        }
      } catch { /* diagnose stays partial */ }
      return {
        driver: 'native',
        agentPreset,
        sessionId: session?.sessionId ?? null,
        key: session?.key ?? null,
        inflight: Boolean(session?.inflight),
        model: session?.model ? `${session.model.provider}/${session.model.model}` : null,
        effort: session?.reasoningEffort ?? null,
        modelSource: session?.modelSource ?? null,
        usage: session?.lastUsage
          ? { used: session.lastUsage.used, size: session.lastUsage.size, key: session.key ?? null }
          : null,
        thinking,
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
          model: item.model ? `${item.model.provider}/${item.model.model}` : null,
          effort: item.reasoningEffort ?? null,
          modelSource: item.modelSource ?? null,
          usage: item.lastUsage ? { used: item.lastUsage.used, size: item.lastUsage.size } : null,
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
        modelSource: snapshot.modelSource,
        usage: snapshot.usage,
        key: snapshot.key,
      };
    },

    async close() {
      closed = true;
      offError?.();
      offStatus?.();
      const pending = [];
      for (const projectState of projects.values()) {
        for (const session of projectState.sessions.values()) {
          const follow = session.followPromise;
          stopFollow(session);
          if (follow) pending.push(follow.catch(() => {}));
        }
      }
      projects.clear();
      sessionProjects.clear();
      if (pending.length) await Promise.all(pending);
    },
  });
}
