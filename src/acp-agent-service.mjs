// The panel's conversation, driven over ACP.
//
// One `dsh --profile acp` child per project. The child owns the Session (a real
// DSH Session, persisted by DSH), so the panel and the sidebar show the same
// conversation: thinking, tool cards, permissions and resume all travel as ACP
// `session/update`s instead of being re-invented here. See docs/ARCHITECTURE.md.
//
// This module is the Host-side half of that contract. It keeps the outward shape
// the RPC layer already expects (send/cancel/modelCatalog/selectModel/
// thinkingOption/selectThinking/answerPermission/activeKey) so the facade, the
// event stream and the shell's model menu stay unchanged.
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAcpClient } from './acp-client.mjs';

const PROJECT_ID = /^[A-Za-z0-9_-]{6,40}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
// ACP resumes ids it issued at session/new (uuids). `session/list` also shows
// DSH-side ids that ACP answers "invalid params" for, so only ours are resumed.
const RESUMABLE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
// The panel's conversation ids (`s<base36><base36>`); '' is the project's default.
const CONVERSATION = /^[A-Za-z0-9_-]{1,64}$/;
const failure = (code, detail) => Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code });
const text = value => typeof value === 'string' && value.length > 0;

/** Windows paths compare case-insensitively; POSIX ones do not. */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const trim = value => value.replace(/[\\/]+$/, '');
  if (process.platform === 'win32') {
    return trim(left).replaceAll('/', '\\').toLowerCase() === trim(right).replaceAll('/', '\\').toLowerCase();
  }
  return trim(left).replaceAll('\\', '/') === trim(right).replaceAll('\\', '/');
}

/** ACP model option values are provider/model pairs; be liberal about their form. */
function parseChoice(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && text(parsed[0]) && text(parsed[1])) {
      return { provider: parsed[0], model: parsed[1] };
    }
  } catch { /* not JSON: fall through */ }
  const slash = value.indexOf('/');
  if (slash > 0 && slash < value.length - 1) return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
  return undefined;
}

/**
 * ACP advertises model choices as free-form option entries: either flat
 * `{value,name}` rows or `{group,name,options:[…]}` groups. The shell's menu wants
 * the DSH catalog shape `{groups:[{id,name,models}], default}`, so flatten it here.
 */
export function catalogFromConfigOptions(configOptions = []) {
  const option = configOptions.find(item => item && (item.category === 'model' || item.id === 'model'));
  if (!option) return { groups: [] };
  const groups = new Map();
  const add = (groupId, groupName, entry) => {
    const choice = parseChoice(entry?.value);
    if (!choice || !text(entry?.name)) return;
    if (!groups.has(groupId)) groups.set(groupId, { id: groupId, name: groupName || groupId, models: [] });
    const models = groups.get(groupId).models;
    if (models.some(item => item.id === choice.model)) return;
    models.push({
      id: choice.model,
      provider: choice.provider,
      name: entry.name,
      ...(text(entry.description) ? { description: entry.description } : {}),
    });
  };
  for (const entry of Array.isArray(option.options) ? option.options : []) {
    if (Array.isArray(entry?.options)) {
      const groupId = typeof entry.group === 'string' && entry.group ? entry.group : String(entry.name ?? 'models');
      const groupName = text(entry.name) ? entry.name : groupId;
      for (const child of entry.options) add(groupId, groupName, child);
    } else {
      const choice = parseChoice(entry?.value);
      add(choice?.provider ?? 'models', choice?.provider ?? 'models', entry);
    }
  }
  const current = parseChoice(option.currentValue);
  // The old V4 is not offered any more: the panel should run the person's
  // current model, and when that is unavailable, the official V4.1 Flash —
  // never the model the child would otherwise pick by itself.
  const hidden = process.env.NO996_OPENFILM_KEEP_V4_FLASH === '1' ? null : { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
  const groupsOut = [...groups.values()]
    .map(group => ({ ...group, models: group.models.filter(model => !(hidden && model.provider === hidden.provider && model.id === hidden.model)) }))
    .filter(group => group.models.length > 0);
  const fallback = hidden && current && current.provider === hidden.provider && current.model === hidden.model
    ? { provider: 'deepseek-official', model: 'deepseek-flash' }
    : current;
  return {
    groups: groupsOut,
    ...(fallback ? { default: fallback } : {}),
  };
}

/** The ACP value that selects this provider/model, as advertised by the agent. */
function valueForChoice(configOptions, choice) {
  const option = configOptions.find(item => item && (item.category === 'model' || item.id === 'model'));
  const entries = [];
  for (const entry of Array.isArray(option?.options) ? option.options : []) {
    if (Array.isArray(entry?.options)) entries.push(...entry.options);
    else entries.push(entry);
  }
  const match = entries.find(entry => {
    const parsed = parseChoice(entry?.value);
    return parsed && parsed.provider === choice.provider && parsed.model === choice.model;
  });
  return match ? match.value : JSON.stringify([choice.provider, choice.model]);
}

function thinkingFromConfigOptions(configOptions = []) {
  const option = configOptions.find(item => item && (item.category === 'thought_level' || item.id === 'reasoning_effort'));
  if (!option || !Array.isArray(option.options) || option.options.length === 0) return null;
  return {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    ...(text(option.currentValue) ? { currentValue: option.currentValue } : {}),
    options: option.options
      .filter(entry => text(entry?.value) && text(entry?.name))
      .slice(0, 32)
      .map(entry => ({ value: entry.value, name: entry.name, ...(text(entry.description) ? { description: entry.description } : {}) })),
  };
}

/**
 * @param {object} deps
 * @param {(projectId: string) => Promise<{projectId: string, path: string}>} deps.verifier
 * @param {{get: Function, set: Function}} deps.store - project -> ACP session id
 * @param {(projectId: string, event: object) => Promise<boolean>|boolean} deps.emit - SSE publish
 * @param {object} [deps.approvals] - createOfficialApprovals instance
 * @param {(event: string, fields?: object) => void} [deps.log]
 * @param {Function} [deps.createClient] - injectable for tests
 * @param {string} [deps.imageDir] - where unsupported inline images are materialised
 */
export function createAcpAgentService({ verifier, store, emit, approvals, log, createClient = options => createAcpClient(options), imageDir = join(tmpdir(), 'no996-openfilm-chat-images'), defaultSelection = () => undefined, permissionMode = () => undefined, mcpServers, onClosed, prepareProject, spawnArgs }) {
  if (typeof verifier !== 'function' || typeof emit !== 'function' || !store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new TypeError('verifier, store and emit are required');
  }
  // A project owns one child; the child owns one ACP Session per conversation.
  //
  // The page keeps several conversations per project (its session bar) and each is
  // its own DSH Session — one child per conversation would multiply processes and
  // revoke the others' MCP tokens, so the split is inside the child. Everything
  // session-scoped (the id, the model menu, the running turn, the live-frame
  // counters) lives on `session`; everything process-scoped (the client, image
  // support, the tap handshake) stays on `child`.
  const children = new Map();
  // A child that was replaced on purpose must not report an exit as news: its
  // handler would delete the entry and revoke the MCP token of its successor.
  const retired = new WeakSet();
  let closed = false;

  const childOf = projectId => {
    if (!PROJECT_ID.test(projectId)) throw failure('OFFICIAL_AGENT_INPUT', 'invalid project');
    let child = children.get(projectId);
    if (child) return child;
    child = {
      projectId,
      client: undefined,
      imageEnabled: false,
      // The child a session is opening on, so an update that arrives before the
      // session id is known still reaches it instead of being dropped.
      pending: undefined,
      // The session whose turn is running: a permission request carries no session
      // id, so it is answered under the turn that asked for it.
      running: undefined,
      // The model overlay was refused once: do not offer it again, or every
      // conversation would pay for the same failed spawn.
      modelRejected: false,
      ready: undefined,
      lastUsed: Date.now(),
      // Live-frame health of the child (the tap says hello once it is admitted).
      streamConnected: false,
      streamLastAt: 0,
      sessions: new Map(),
    };
    children.set(projectId, child);
    return child;
  };

  /** One conversation's ACP Session inside a child. `''` is the default conversation. */
  const sessionOf = (child, conversation) => {
    const id = typeof conversation === 'string' && CONVERSATION.test(conversation) ? conversation : '';
    let session = child.sessions.get(id);
    if (session) return session;
    session = {
      conversation: id,
      sessionId: undefined,
      configOptions: [],
      key: undefined,
      inflight: undefined,
      ready: undefined,
      reopened: false,
      lastUsed: Date.now(),
      // Counters are per turn and reset by send().
      turnStats: { deltas: 0, seals: 0, syncs: 0, textCommits: 0 },
    };
    child.sessions.set(id, session);
    return session;
  };

  const sessionById = (child, sessionId) => {
    if (!text(sessionId)) return child.pending;
    for (const session of child.sessions.values()) if (session.sessionId === sessionId) return session;
    return child.pending;
  };

  function attach(child) {
    const { client, projectId } = child;
    client.onUpdate(params => {
      const session = sessionById(child, params?.sessionId);
      if (!session) return;
      const update = params?.update;
      if (update && update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) session.configOptions = update.configOptions;
      // How many committed paragraphs this turn produced: the other half of "did the
      // live frames arrive at all" (see the acp-stream line logged at the end of a turn).
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && text(update.content.text)) {
        session.turnStats.textCommits += 1;
      }
      void Promise.resolve(emit(projectId, { key: session.key ?? 'acp', kind: 'update', update })).catch(() => {});
    });
    // The live tokens the child sees but ACP does not carry (see src/acp-stream-tap.mjs):
    // they ride beside the committed updates, keyed to the same turn. A subagent streams in
    // the same process under its own Session, so only this child's Sessions are forwarded.
    client.on('stream', frame => {
      const session = sessionById(child, frame?.sessionId);
      if (!session) return;
      child.streamLastAt = Date.now();
      if (frame?.sync === true) session.turnStats.syncs += 1;
      else if (frame?.seal === true) session.turnStats.seals += 1;
      else session.turnStats.deltas += 1;
      void Promise.resolve(emit(projectId, { key: session.key ?? 'acp', kind: 'stream', stream: frame })).catch(() => {});
    });
    // The tap says hello once it is admitted; a child that never says it has no tap
    // (or could not load it), which is exactly the state this module must name.
    client.on('hello', () => { child.streamConnected = true; });
    client.on('exit', ({ code }) => {
      void log?.('acp-exited', { projectId, code });
      if (retired.has(client)) return;
      if (children.get(projectId) === child) children.delete(projectId);
      try { onClosed?.(projectId); } catch { /* nothing left to clean */ }
    });
  }

  /** The approved preset for this project; DSH spells it as a mode name. */
  async function modeOf(projectId) {
    try {
      const mode = await permissionMode(projectId);
      return mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access' ? mode : undefined;
    } catch { return undefined; }
  }

  /**
   * The child process, spawned once per project.
   *
   * The two overlays stay apart on purpose: the model one may be refused (a provider
   * the profile has no adapter for) and is dropped on retry, while the tap overlay is
   * what makes the answer stream at all. Sharing one array is how a model fallback
   * silently turned every answer back into committed paragraphs (ADR-0010 §2.5).
   */
  async function ensureChild(child, projectId, project, overlays) {
    if (child.client) return child;
    if (child.ready) return await child.ready;
    child.ready = (async () => {
      const mode = await modeOf(projectId);
      const modelArgs = Array.isArray(overlays) ? [...overlays] : (text(overlays?.model) ? ['--patch', overlays.model] : []);
      // Never dropped: the tap makes the answer stream, the instructions decide who the
      // agent is and where its instruction chain stops. Only the model overlay is optional.
      const tapArgs = Array.isArray(overlays) ? [] : [
        ...(text(overlays?.instructions) ? ['--patch', overlays.instructions] : []),
        ...(text(overlays?.tap) ? ['--patch', overlays.tap] : []),
      ];
      // A fresh process means fresh MCP credentials: the endpoint is this Host,
      // and only the child holding the token may call the film tools.
      const servers = typeof mcpServers === 'function' ? await mcpServers(projectId, project.path) : undefined;
      const wiring = Array.isArray(servers) && servers.length > 0 ? { mcpServers: servers } : {};
      const startChild = async args => {
        child.pending = undefined;
        child.client = createClient({ env: { ...process.env, ...(mode ? { DSH_PERMISSION_MODE: mode } : {}) }, log, ...(args.length > 0 ? { args } : {}) });
        attach(child);
        const capabilities = await child.client.start();
        child.imageEnabled = capabilities?.agentCapabilities?.promptCapabilities?.image === true;
        child.client.setPermissionHandler(params => askPermission(child, params));
      };
      const offered = child.modelRejected ? tapArgs : [...modelArgs, ...tapArgs];
      try {
        await startChild(offered);
      } catch (error) {
        if (offered.length === 0 || child.modelRejected) {
          const dead = child.client;
          child.client = undefined;
          if (dead) { try { await dead.close(); } catch { /* already gone */ } }
          throw error;
        }
        void log?.('acp-model-fallback', { projectId, reason: String(error?.code ?? error).slice(0, 60) });
        const previous = child.client;
        retired.add(previous);
        try { await previous.close(); } catch { /* already gone */ }
        child.modelRejected = true;
        // Only the model overlay goes: the tap stays, or this child would answer in
        // committed paragraphs for the rest of its life.
        await startChild(tapArgs);
      }
      child.wiring = wiring;
      return child;
    })();
    try {
      return await child.ready;
    } catch (error) {
      child.ready = undefined;
      const dead = child.client;
      child.client = undefined;
      if (dead) { try { await dead.close(); } catch { /* already gone */ } }
      throw error;
    }
  }

  /**
   * One conversation's Session: resumed from its own stored id, or created.
   *
   * The id is per conversation, so a new chat in the same project starts a new DSH
   * Session instead of continuing the previous one — the bug where a fresh
   * conversation answered with the old one's history.
   */
  async function openSession(child, session, project) {
    const { projectId } = child;
    const wiring = child.wiring ?? {};
    child.pending = session;
    try {
      const known = (typeof store.getSession === 'function' ? store.getSession(projectId, session.conversation) : undefined)
        ?? (session.conversation === '' ? store.get(projectId) : undefined);
      if (known?.sessionId && RESUMABLE.test(known.sessionId)) {
        try {
          const resumed = await child.client.resumeSession({ sessionId: known.sessionId, cwd: project.path, ...wiring });
          session.sessionId = known.sessionId;
          session.reopened = true;
          session.configOptions = resumed?.configOptions ?? [];
          logSessionModel(log, child, session, 'resumed');
          // No default on resume: ACP keeps the model the person chose for this
          // Session, and re-applying the DSH default would silently undo it.
          return session;
        } catch (error) {
          void log?.('acp-resume-failed', { projectId, conversation: session.conversation, reason: String(error?.code ?? error).slice(0, 80) });
        }
      }
      const created = await child.client.newSession({ cwd: project.path, ...wiring });
      if (!created || !text(created.sessionId)) throw failure('OFFICIAL_AGENT_UNAVAILABLE', 'agent returned no session');
      session.sessionId = created.sessionId;
      session.reopened = false;
      session.configOptions = created.configOptions ?? [];
      logSessionModel(log, child, session, 'created');
      if (typeof store.setSession === 'function') store.setSession(projectId, session.conversation, { sessionId: created.sessionId, cwd: project.path });
      else store.set(projectId, { sessionId: created.sessionId, cwd: project.path });
      void log?.('acp-session', { projectId, conversation: session.conversation, created: true });
      await adoptDefaultSelection(child, session);
      return session;
    } finally {
      child.pending = undefined;
    }
  }

  async function ensure(projectId, conversation) {
    if (closed) throw failure('OFFICIAL_AGENT_CLOSED');
    const child = childOf(projectId);
    const session = sessionOf(child, conversation);
    if (session.ready) return await session.ready;
    session.ready = (async () => {
      const project = await verifier(projectId);
      if (!project || !text(project.path)) throw failure('OFFICIAL_AGENT_UNAVAILABLE', 'project has no folder');
      // The ACP agent gets its editing instructions from the project folder, not
      // from our preset. Best effort: a project that cannot be written stays usable.
      try { await prepareProject?.(projectId, project.path); } catch (error) { void log?.('prepare-project-failed', { projectId, reason: String(error?.code ?? error).slice(0, 60) }); }
      // Flags that must be in place *before* initialize (the acp profile's own
      // model decides whether images may be sent at all), so they are computed
      // per spawn rather than per session.
      let overlays = {};
      try { overlays = (await spawnArgs?.()) ?? {}; } catch (error) { void log?.('acp-spawn-args-failed', { projectId, reason: String(error?.code ?? error).slice(0, 60) }); }
      await ensureChild(child, projectId, project, overlays);
      try {
        return await openSession(child, session, project);
      } catch (error) {
        // Opening a Session can fail on the model alone: the DSH selection may belong
        // to a provider the acp profile has no adapter for, and then both resume and
        // new are refused before a Session exists. One retry on a child without that
        // overlay (the profile's own default model) is the difference between a
        // conversation and a dead panel. Only the first Session of a child can be
        // affected: no other conversation exists on it yet.
        if (child.modelRejected) throw error;
        void log?.('acp-model-fallback', { projectId, reason: String(error?.code ?? error).slice(0, 60) });
        const previous = child.client;
        retired.add(previous);
        child.client = undefined;
        child.ready = undefined;
        child.modelRejected = true;
        try { await previous?.close(); } catch { /* already gone */ }
        await ensureChild(child, projectId, project, overlays);
        return await openSession(child, session, project);
      }
    })();
    try {
      return await session.ready;
    } catch (error) {
      // A half-open child (spawned but failed to announce a session) must not be
      // orphaned: the retry builds a new one, and the old process would linger.
      session.ready = undefined;
      // Which stage failed matters more than the panel's generic bubble: spawn,
      // initialize, resume and session/new all surface here.
      void log?.('acp-session-failed', { projectId, conversation: session.conversation, reason: String(error?.message ?? error?.code ?? error).slice(0, 120) });
      session.sessionId = undefined;
      throw error;
    }
  }

  /**
   * What the child actually runs. Without it "no thinking shown" is undecidable:
   * a resumed Session keeps the model it was created with, and providers differ
   * in whether they return reasoning content at all.
   */
  function logSessionModel(logger, child, session, how) {
    const pick = (category, id) => session.configOptions.find(item => item && (item.category === category || item.id === id));
    const value = option => { try { const parsed = JSON.parse(option?.currentValue ?? '""'); return Array.isArray(parsed) ? parsed.join('/') : String(parsed ?? ''); } catch { return String(option?.currentValue ?? ''); } };
    void logger?.('acp-session-model', { projectId: child.projectId, conversation: session.conversation, how, model: value(pick('model', 'model')).slice(0, 60), effort: value(pick('thought_level', 'reasoning_effort')).slice(0, 20) });
  }

  /**
   * The panel should start on the same model the sidebar uses. The acp profile has
   * its own default, so the Host's current selection is applied right after the
   * Session opens (best effort: a stale or unadvertised selection is ignored).
   */
  async function adoptDefaultSelection(child, session) {
    let selection;
    try { selection = defaultSelection(); } catch { selection = undefined; }
    const catalog = catalogFromConfigOptions(session.configOptions);
    let target = selection && text(selection.provider) && text(selection.model)
      && catalog.groups.some(group => group.id === selection.provider && group.models.some(item => item.id === selection.model))
      ? selection
      : undefined;
    if (!target) {
      // The child's own default is the retired V4. When the person's selection
      // cannot be applied, move it to the official V4.1 Flash rather than leave
      // the first turn on a model the menu no longer offers.
      const option = session.configOptions.find(item => item && (item.category === 'model' || item.id === 'model'));
      let current;
      try {
        const parsed = JSON.parse(option?.currentValue ?? '');
        if (Array.isArray(parsed) && parsed.length === 2) current = { provider: parsed[0], model: parsed[1] };
      } catch { current = undefined; }
      if (current?.provider === 'deepseek-official' && current.model === 'deepseek-v4-flash'
        && catalog.groups.some(group => group.id === 'deepseek-official' && group.models.some(item => item.id === 'deepseek-flash'))) {
        target = { provider: 'deepseek-official', model: 'deepseek-flash' };
      }
    }
    if (!target) return;
    const option = session.configOptions.find(item => item && (item.category === 'model' || item.id === 'model'));
    if (option && option.currentValue !== valueForChoice(session.configOptions, target)) {
      try {
        const updated = await child.client.setConfigOption({
          sessionId: session.sessionId,
          configId: option.id ?? 'model',
          value: valueForChoice(session.configOptions, target),
        });
        if (Array.isArray(updated?.configOptions) && updated.configOptions.length > 0) session.configOptions = updated.configOptions;
        void log?.('acp-default-model', { projectId: child.projectId, conversation: session.conversation, provider: target.provider, model: target.model });
      } catch (error) {
        void log?.('acp-default-model-failed', { projectId: child.projectId, conversation: session.conversation, reason: String(error?.code ?? error).slice(0, 80) });
      }
    }
    // Match the DSH-side thinking intensity too, so the first turn of the panel
    // runs at the level the person already uses in the sidebar.
    if (!selection) return;
    const effort = selection.reasoningEffort ?? selection.effort;
    const thinkingOptionId = session.configOptions.find(item => item && (item.category === 'thought_level' || item.id === 'reasoning_effort'));
    if (!text(effort) || !thinkingOptionId || thinkingOptionId.currentValue === effort) return;
    if (!Array.isArray(thinkingOptionId.options) || !thinkingOptionId.options.some(item => item?.value === effort)) return;
    try {
      const updated = await child.client.setConfigOption({ sessionId: session.sessionId, configId: thinkingOptionId.id ?? 'reasoning_effort', value: effort });
      if (Array.isArray(updated?.configOptions) && updated.configOptions.length > 0) session.configOptions = updated.configOptions;
      void log?.('acp-default-effort', { projectId: child.projectId, conversation: session.conversation, value: effort });
    } catch (error) {
      void log?.('acp-default-effort-failed', { projectId: child.projectId, conversation: session.conversation, reason: String(error?.code ?? error).slice(0, 80) });
    }
  }

  /**
   * What the live channel actually delivered this turn.
   *
   * The panel degrades honestly without frames (committed paragraphs still arrive), which is
   * exactly why the failure is invisible: a turn that commits text and receives zero deltas
   * must say so, or the next release ships the same bug again (ADR-0010 §2.5).
   *
   * Logged one tick later on purpose: the child writes its last frames on another socket, so
   * at the moment the prompt result arrives they may still be in the kernel buffer. Counting
   * before that drain would report "0 deltas" for a turn that streamed fine.
   */
  function reportStream(child, session) {
    // The object reference is the turn: send() replaces it, so a later turn cannot
    // rewrite the numbers read below while this turn's socket data drains.
    const stats = session.turnStats ?? { deltas: 0, seals: 0, syncs: 0, textCommits: 0 };
    const timer = setTimeout(() => {
      const connected = child.streamConnected === true;
      void log?.('acp-stream', {
        projectId: child.projectId,
        conversation: session.conversation,
        deltas: stats.deltas,
        seals: stats.seals,
        syncs: stats.syncs,
        textCommits: stats.textCommits,
        connected,
      });
      if (stats.textCommits > 0 && stats.deltas === 0) {
        void log?.('acp-stream-silent', { projectId: child.projectId, reason: connected ? 'connected-no-frames' : 'tap-absent' });
      }
    }, 50);
    timer.unref?.();
  }

  async function askPermission(child, params) {
    // No approvals coordinator means the Host cannot show the permission row, so
    // the only safe answer is to refuse: silently allowing would contradict the
    // promise that a tool never runs without the person seeing the request.
    if (!approvals || typeof approvals.request !== 'function') {
      void log?.('acp-permission-unavailable', { projectId: child.projectId });
      return null;
    }
    const session = child.running ?? child.pending;
    const title = text(params?.toolCall?.title) && TOOL_NAME.test(params.toolCall.title) ? params.toolCall.title : 'tool';
    const outcome = await approvals.request({
      projectId: child.projectId,
      key: session?.key ?? 'acp',
      agentId: session?.sessionId,
      toolName: title,
      ...(typeof params?.toolCall?.toolCallId === 'string' && params.toolCall.toolCallId.length > 0 ? { callId: params.toolCall.toolCallId.slice(0, 200) } : {}),
    });
    if (outcome === 'allowed-once') return 'allow-once';
    if (outcome === 'rejected') return 'reject-once';
    return null;
  }

  /** Inline pictures the route cannot take become paths the agent can read. */
  function materialise(projectId, images) {
    const kept = [];
    for (const [index, image] of (Array.isArray(images) ? images : []).slice(0, 8).entries()) {
      if (!image || typeof image.data !== 'string' || typeof image.mediaType !== 'string') continue;
      const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[image.mediaType];
      if (!extension) continue;
      try {
        mkdirSync(imageDir, { recursive: true });
        const file = join(imageDir, `${projectId}-${Date.now()}-${index}.${extension}`);
        writeFileSync(file, Buffer.from(image.data, 'base64'));
        kept.push(file);
      } catch { /* an unreadable picture must not fail the turn */ }
    }
    return kept;
  }

  return Object.freeze({
    /** Adopt the panel's key and send one turn. `emit` carries every update. */
    async send(projectId, { conversation, key, turnId, text: promptText, images } = {}) {
      if (typeof promptText !== 'string' || promptText.length > 200000) throw failure('OFFICIAL_AGENT_INPUT', 'bad prompt');
      const child = childOf(projectId);
      const session = await ensure(projectId, conversation);
      if (session.inflight) {
        // One active turn per Session, as ACP allows. The panel names this state
        // instead of hanging; the person can cancel and resend.
        throw failure('OFFICIAL_AGENT_BUSY', 'a turn is already running');
      }
      session.key = typeof key === 'string' && key ? key : session.key;
      child.lastUsed = Date.now();
      session.lastUsed = child.lastUsed;
      // One turn's live-frame budget. A turn that commits text but receives no delta is
      // reported by name at the end (acp-stream-silent), not left to be guessed from the UI.
      session.turnStats = { deltas: 0, seals: 0, syncs: 0, textCommits: 0 };
      const blocks = [];
      const pictures = (Array.isArray(images) ? images : []).slice(0, 8);
      if (child.imageEnabled) {
        for (const image of pictures) {
          if (typeof image?.data === 'string' && typeof image?.mediaType === 'string' && image.mediaType.startsWith('image/')) {
            blocks.push({ type: 'image', mimeType: image.mediaType, data: image.data });
          }
        }
      }
      const references = child.imageEnabled ? [] : materialise(projectId, pictures);
      const body = [promptText, ...references.map(file => `[reference image] ${file}`)].filter(part => typeof part === 'string' && part.trim()).join('\n\n');
      if (body) blocks.push({ type: 'text', text: body });
      if (blocks.length === 0) throw failure('OFFICIAL_AGENT_INPUT', 'empty prompt');
      session.inflight = { turnId, cancelled: false };
      child.running = session;
      try {
        let result;
        try {
          result = await child.client.prompt({ sessionId: session.sessionId, blocks });
        } catch (error) {
          const saidImage = /image|content/i.test(String(error?.message ?? ''));
          if (!child.imageEnabled || !saidImage || !blocks.some(block => block.type === 'image')) throw error;
          // The route advertised pictures but the turn still failed on them: fall
          // back to paths so the conversation continues instead of dying.
          const retryBlocks = [];
          const fallback = await Promise.resolve(materialise(projectId, pictures));
          const retryBody = [promptText, ...fallback.map(file => `[reference image] ${file}`)]
            .filter(part => typeof part === 'string' && part.trim()).join('\n\n');
          if (retryBody) retryBlocks.push({ type: 'text', text: retryBody });
          void log?.('acp-image-fallback', { projectId });
          result = await child.client.prompt({ sessionId: session.sessionId, blocks: retryBlocks });
        }
        const stopReason = result?.stopReason === 'cancelled' ? 'cancelled' : 'end_turn';
        reportStream(child, session);
        // The page ends the visible turn only on this terminal event; without a
        // live stream the honest answer is a named failure, not a 15 s silence.
        if (await emit(projectId, { key: session.key, kind: 'done', turnId, ok: true, stopReason }) === false) {
          throw failure('OFFICIAL_AGENT_STREAM_LOST', 'no live event stream accepted the terminal event');
        }
        return { ok: true, stopReason };
      } catch (error) {
        const reason = String(error?.code ?? error?.message ?? error).slice(0, 120);
        reportStream(child, session);
        void log?.('acp-prompt-failed', { projectId, reason });
        await emit(projectId, { key: session.key, kind: 'done', turnId, ok: false, error: reason }).catch(() => {});
        throw failure('OFFICIAL_AGENT_FAILED', reason);
      } finally {
        session.inflight = undefined;
        if (child.running === session) child.running = undefined;
      }
    },

    async cancel(projectId, conversation) {
      const child = children.get(projectId);
      const session = child ? sessionOf(child, conversation) : undefined;
      if (!child || !session || !session.sessionId || !session.inflight) throw failure('OFFICIAL_AGENT_NOT_RUNNING');
      session.inflight.cancelled = true;
      child.client.cancel(session.sessionId);
      return { ok: true };
    },

    async modelCatalog(projectId, conversation) {
      const session = await ensure(projectId, conversation);
      const catalog = catalogFromConfigOptions(session.configOptions);
      if (catalog.groups.length === 0) throw failure('OFFICIAL_AGENT_MODEL_UNAVAILABLE', 'agent advertised no models');
      return catalog;
    },

    async selectModel(projectId, selection, conversation) {
      const child = childOf(projectId);
      const session = await ensure(projectId, conversation);
      const provider = selection?.provider;
      const model = selection?.model;
      const catalog = catalogFromConfigOptions(session.configOptions);
      if (!catalog.groups.some(group => group.id === provider && group.models.some(item => item.id === model))) {
        throw failure('OFFICIAL_AGENT_MODEL_UNAVAILABLE', 'model not offered');
      }
      const value = valueForChoice(session.configOptions, { provider, model });
      const updated = await child.client.setConfigOption({ sessionId: session.sessionId, configId: session.configOptions.find(item => item.category === 'model' || item.id === 'model')?.id ?? 'model', value });
      if (Array.isArray(updated?.configOptions) && updated.configOptions.length > 0) session.configOptions = updated.configOptions;
      if (typeof store.setSession === 'function') store.setSession(projectId, session.conversation, { sessionId: session.sessionId, model: value });
      else store.set(projectId, { sessionId: session.sessionId, model: value });
      return { ok: true, currentValue: text(updated?.currentValue) ? updated.currentValue : value };
    },

    async thinkingOption(projectId, conversation) {
      const session = await ensure(projectId, conversation);
      return thinkingFromConfigOptions(session.configOptions);
    },

    async selectThinking(projectId, value, conversation) {
      const child = childOf(projectId);
      const session = await ensure(projectId, conversation);
      const option = session.configOptions.find(item => item && (item.category === 'thought_level' || item.id === 'reasoning_effort'));
      if (!option || typeof value !== 'string') throw failure('OFFICIAL_AGENT_MODEL_UNAVAILABLE', 'no thinking option');
      // Only a value the menu was shown may be applied: the page names a choice, it
      // does not get to invent one.
      if (Array.isArray(option.options) && option.options.length > 0 && !option.options.some(item => item?.value === value)) {
        throw failure('OFFICIAL_AGENT_INPUT', 'thinking level not offered');
      }
      const updated = await child.client.setConfigOption({ sessionId: session.sessionId, configId: option.id, value });
      if (Array.isArray(updated?.configOptions) && updated.configOptions.length > 0) session.configOptions = updated.configOptions;
      return { ok: true };
    },

    answerPermission(projectId, { key, requestId, optionId } = {}) {
      if (!approvals || typeof approvals.answerRequest !== 'function') return { ok: false };
      const accepted = approvals.answerRequest({ projectId, key, requestId, optionId });
      return { ok: accepted === true };
    },

    /**
     * Forget a project's child so the next turn spawns one under the new preset.
     * Called when the person changes the permission row, the only setting that
     * cannot be changed inside a running child.
     */
    async reset(projectId) {
      const child = children.get(projectId);
      if (!child) return { ok: true };
      children.delete(projectId);
      try { await child.client?.close?.(); } catch { /* already gone */ }
      try { onClosed?.(projectId); } catch { /* nothing left to clean */ }
      return { ok: true };
    },

    activeKey(projectId, conversation) {
      const child = children.get(projectId);
      if (!child) return null;
      return sessionOf(child, conversation).key ?? null;
    },

    diagnose(projectId, conversation) {
      const child = children.get(projectId);
      const session = child ? sessionOf(child, conversation) : undefined;
      return {
        sessionId: session?.sessionId ?? null,
        key: session?.key ?? null,
        inflight: Boolean(session?.inflight),
        imageEnabled: child?.imageEnabled === true,
        // Whether this child ever said hello on the live channel, and what the last
        // turn received: the two facts that separate "no tap" from "no frames".
        stream: {
          connected: child?.streamConnected === true,
          deltas: session?.turnStats?.deltas ?? 0,
          textCommits: session?.turnStats?.textCommits ?? 0,
          lastAt: child?.streamLastAt ?? 0,
        },
        configOptions: session ? session.configOptions.map(option => ({ id: option.id, category: option.category, options: Array.isArray(option.options) ? option.options.length : 0 })) : [],
        // Every conversation this child holds, so "is this project really several
        // Sessions?" is answerable without reading the store file.
        sessions: child ? [...child.sessions.values()].map(item => ({
          conversation: item.conversation,
          sessionId: item.sessionId ?? null,
          resumed: item.reopened === true,
          inflight: Boolean(item.inflight),
          lastUsed: item.lastUsed,
        })) : [],
      };
    },

    async close() {
      closed = true;
      const entries = [...children.values()];
      children.clear();
      await Promise.allSettled(entries.map(child => child.client?.close?.()));
      approvals?.close?.();
    },

    /**
     * What the page needs to tell "this conversation continues where it left off"
     * from "a brand-new Session was opened": the shell shows a hand-over notice
     * when it believes the previous Session could not be reopened.
     */
    sessionState(projectId, conversation) {
      const child = children.get(projectId);
      if (!child) return undefined;
      const session = sessionOf(child, conversation);
      if (!session.sessionId) return undefined;
      return { sessionId: session.sessionId, resumed: session.reopened === true };
    },
    /** Test seam: the ACP session id chosen for a conversation, once ensured. */
    sessionOf(projectId, conversation) {
      const child = children.get(projectId);
      return child ? sessionOf(child, conversation).sessionId : undefined;
    },
    randomId: () => randomUUID(),
  });
}
