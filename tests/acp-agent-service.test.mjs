// The ACP-backed conversation service: what the panel's model menu, thinking
// menu and prompt now talk to. Tested against the wire-level stand-in agent, so
// no real model is ever called (AGENTS §1).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAcpClient } from '../src/acp-client.mjs';
import { catalogFromConfigOptions, createAcpAgentService } from '../src/acp-agent-service.mjs';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const PROJECT = 'proj123456';

function memoryStore(seed = {}) {
  const table = new Map(Object.entries(seed));
  const scoped = new Map();
  const keyOf = (project, conversation) => `${project}\u0000${conversation ?? ''}`;
  return {
    get: id => table.get(id),
    set: (id, value) => table.set(id, value),
    getSession: (project, conversation) => scoped.get(keyOf(project, conversation)),
    setSession: (project, conversation, value) => {
      scoped.set(keyOf(project, conversation), value);
      // The real store keeps the default conversation as the project's own record;
      // mirror that so `get` keeps answering for callers that only know a project.
      if (!conversation) table.set(project, value);
    },
    all: () => [...table],
    scoped: () => [...scoped.entries()],
  };
}

// The Host always has an approvals coordinator; a granted request is the normal
// answer in these tests, unless a test supplies its own (or null for the missing case).
const allowOnce = () => ({ request: async () => 'allowed-once', answerRequest: () => true, close() {} });

function harness({ mode, image = false, emptyList = false, stream = false, store = memoryStore(), approvals = allowOnce(), defaultSelection, permissionMode, onOptions, mcpServers, onClosed, prepareProject, startModel, spawnArgs } = {}) {
  const events = [];
  const service = createAcpAgentService({
    verifier: async projectId => ({ projectId, path: 'C:\\fake' }),
    store,
    emit: (projectId, event) => { events.push({ projectId, ...event }); return true; },
    approvals,
    defaultSelection: defaultSelection ?? (() => undefined),
    permissionMode: permissionMode ?? (() => undefined),
    mcpServers: mcpServers ?? undefined,
    onClosed,
    prepareProject,
    spawnArgs,
    createClient: options => {
      onOptions?.(options);
      return createAcpClient({
        resolve: () => ({ command: process.execPath, args: [fixture] }),
        ...(options?.args ? { args: options.args } : {}),
        env: { ...process.env, ...(mode ? { FAKE_ACP_MODE: mode } : {}), ...(image ? { FAKE_ACP_IMAGE: '1' } : {}), ...(emptyList ? { FAKE_ACP_EMPTY_LIST: '1' } : {}), ...(mcpServers ? { FAKE_ACP_MCP: '1' } : {}), ...(startModel ? { FAKE_ACP_START_MODEL: startModel } : {}), ...(stream ? { FAKE_ACP_STREAM: '1' } : {}), ...(options?.env ?? {}) },
        requestTimeoutMs: 5000,
        spawnChild: (command, args, spawnOptions) => spawn(command, args, spawnOptions),
      });
    },
  });
  return { service, events };
}

const updatesOf = events => events.filter(event => event.kind === 'update').map(event => event.update);

test('a child that fails to announce a session is closed before the retry', async () => {
  const made = [];
  const service = createAcpAgentService({
    verifier: async projectId => ({ projectId, path: 'C:\\fake' }),
    store: memoryStore(),
    emit: () => true,
    createClient: () => {
      const client = {
        closed: false,
        onUpdate() {},
        on() {},
        setPermissionHandler() {},
        async start() { throw Object.assign(new Error('spawn failed'), { code: 'ACP_SPAWN' }); },
        async close() { client.closed = true; },
      };
      made.push(client);
      return client;
    },
  });
  await assert.rejects(service.modelCatalog(PROJECT), error => error.code === 'ACP_SPAWN');
  await assert.rejects(service.modelCatalog(PROJECT), error => error.code === 'ACP_SPAWN');
  assert.equal(made.length, 2, 'each attempt builds its own child');
  assert.equal(made[0].closed, true, 'the failed child is stopped, not orphaned');
  assert.equal(made[1].closed, true);
  await service.close();
});

test('each conversation is its own Session, and a new chat does not continue the old one', async () => {
  const store = memoryStore();
  const { service } = harness({ store });
  // Two chats in one project: the page's session bar does exactly this, and before
  // the conversation key reached the Host they shared one DSH Session — a new chat
  // answered with the previous one's history.
  await service.send(PROJECT, { conversation: 'sa', key: 'k1', turnId: 't1', text: 'one' });
  await service.send(PROJECT, { conversation: 'sb', key: 'k2', turnId: 't2', text: 'two' });
  const a = service.sessionOf(PROJECT, 'sa');
  const b = service.sessionOf(PROJECT, 'sb');
  assert.ok(a && b);
  assert.notEqual(a, b, 'two conversations, two Sessions');

  // Going back to the first chat keeps its own Session: that is what "continue the
  // conversation" means, and it must not depend on which chat ran last.
  await service.send(PROJECT, { conversation: 'sa', key: 'k3', turnId: 't3', text: 'three' });
  assert.equal(service.sessionOf(PROJECT, 'sa'), a);
  assert.equal(service.sessionOf(PROJECT, 'sb'), b);
  assert.equal(store.getSession(PROJECT, 'sa')?.sessionId, a, 'the id is remembered per conversation');
  assert.equal(store.getSession(PROJECT, 'sb')?.sessionId, b);

  // The diagnose view names every Session the child holds, so "is this really
  // isolated?" is answerable from the panel.
  const seen = service.diagnose(PROJECT, 'sa');
  assert.deepEqual(seen.sessions.map(item => item.conversation).sort(), ['sa', 'sb']);
  assert.equal(seen.sessionId, a);
  await service.close();
});

test('a second conversation resumes its own stored Session after a restart', async () => {
  const store = memoryStore();
  const first = harness({ store });
  await first.service.send(PROJECT, { conversation: 'sa', key: 'k1', turnId: 't1', text: 'one' });
  await first.service.send(PROJECT, { conversation: 'sb', key: 'k2', turnId: 't2', text: 'two' });
  const a = first.service.sessionOf(PROJECT, 'sa');
  const b = first.service.sessionOf(PROJECT, 'sb');
  await first.service.close();

  const second = harness({ store });
  await second.service.send(PROJECT, { conversation: 'sb', key: 'k3', turnId: 't3', text: 'again' });
  assert.equal(second.service.sessionOf(PROJECT, 'sb'), b, 'resumed, not recreated');
  assert.notEqual(second.service.sessionOf(PROJECT, 'sb'), a);
  await second.service.close();
});

test('the advertised model catalog becomes the DSH shape the menu expects', async () => {
  const { service } = harness();
  const catalog = await service.modelCatalog(PROJECT);
  assert.deepEqual(catalog.groups.map(group => group.id), ['p', 'q']);
  assert.deepEqual(catalog.groups[0].models.map(model => model.id), ['m1', 'm2']);
  assert.deepEqual(catalog.default, { provider: 'p', model: 'm1' });
  await service.close();
});

test('flattening tolerates option rows that carry no group', () => {
  const catalog = catalogFromConfigOptions([
    { id: 'model', category: 'model', currentValue: '["x","y"]', options: [{ value: '["x","y"]', name: 'Y' }] },
  ]);
  assert.deepEqual(catalog.groups, [{ id: 'x', name: 'x', models: [{ id: 'y', provider: 'x', name: 'Y' }] }]);
});

test('the panel session adopts the DSH-side model selection', async () => {
  const { service } = harness({ defaultSelection: () => ({ provider: 'q', model: 'q1' }) });
  const catalog = await service.modelCatalog(PROJECT);
  assert.deepEqual(catalog.default, { provider: 'q', model: 'q1' });
  await service.close();
});

test('opening a session prepares the project folder with the editing instructions', async () => {
  const seen = [];
  const { service } = harness({ prepareProject: async (projectId, projectPath) => { seen.push({ projectId, projectPath }); } });
  await service.modelCatalog(PROJECT);
  assert.deepEqual(seen, [{ projectId: PROJECT, projectPath: 'C:\\fake' }]);
  await service.close();
});

test('the MCP endpoint is handed to the ACP session', async () => {
  const { service, events } = harness({
    mcpServers: async (projectId, path) => [{ type: 'http', name: 'no996-openfilm', url: 'http://127.0.0.1:1/mcp', headers: [] }],
  });
  await service.send(PROJECT, { key: 'k', turnId: 't', text: 'hi' });
  const message = updatesOf(events).find(update => update.sessionUpdate === 'agent_message_chunk');
  assert.match(message.content.text, /mcp:no996-openfilm/);
  await service.close();
});

test('closing a session tells the Host to revoke its credentials', async () => {
  const closed = [];
  const { service } = harness({ onClosed: projectId => closed.push(projectId) });
  await service.modelCatalog(PROJECT);
  await service.reset(PROJECT);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(closed.includes(PROJECT));
  await service.close();
});

test('the remembered permission preset becomes the child sandbox mode', async () => {
  const seen = [];
  const { service } = harness({
    permissionMode: () => 'danger-full-access',
    onOptions: options => seen.push(options),
  });
  await service.modelCatalog(PROJECT);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].env.DSH_PERMISSION_MODE, 'danger-full-access');
  await service.close();
});

test('reset forgets the child so a preset change takes effect on the next turn', async () => {
  let calls = 0;
  const { service } = harness({ onOptions: () => { calls += 1; } });
  await service.modelCatalog(PROJECT);
  assert.equal(calls, 1);
  await service.reset(PROJECT);
  await service.modelCatalog(PROJECT);
  assert.equal(calls, 2);
  await service.close();
});

test('a prompt streams updates under the panel key and ends the turn', async () => {
  const { service, events } = harness();
  const result = await service.send(PROJECT, { key: 'dsh-key-1', turnId: 'turn-1', text: 'hello' });
  assert.equal(result.ok, true);
  assert.equal(result.stopReason, 'end_turn');
  const updates = events.filter(event => event.kind === 'update');
  assert.ok(updates.length >= 2, 'thought and message chunks both arrive');
  assert.ok(updates.every(event => event.key === 'dsh-key-1'));
  const done = events.find(event => event.kind === 'done');
  assert.equal(done.turnId, 'turn-1');
  assert.equal(done.ok, true);
  await service.close();
});

test('DSH-side sessions in the folder are not mistaken for resumable ACP sessions', async () => {
  // session/list reports DSH ids; resuming one fails by protocol. A missing mapping
  // must open a fresh ACP Session instead of pretending the old one came back.
  const { service } = harness({ emptyList: true });
  await service.modelCatalog(PROJECT);
  assert.equal(service.sessionOf(PROJECT), 'session-fake-1');
  await service.close();
});

test('the first turn creates a Session; the id is remembered for resume', async () => {
  const store = memoryStore();
  const first = harness({ store, emptyList: true });
  await first.service.send(PROJECT, { key: 'k', turnId: 't1', text: 'hi' });
  const sessionId = first.service.sessionOf(PROJECT);
  assert.equal(sessionId, 'session-fake-1');
  assert.equal(store.get(PROJECT).sessionId, sessionId);
  await first.service.close();

  const second = harness({ store, emptyList: true });
  const catalog = await second.service.modelCatalog(PROJECT);
  assert.equal(second.service.sessionOf(PROJECT), sessionId, 'the stored id is resumed, not recreated');
  assert.ok(catalog.groups.length > 0);
  await second.service.close();
});

test('per-spawn flags reach the child (the model overlay needs them before initialize)', async () => {
  let options;
  const { service } = harness({ spawnArgs: async () => ['--patch', 'C:\\tmp\\p.yml'], onOptions: value => { options = value; } });
  await service.modelCatalog(PROJECT);
  assert.deepEqual(options.args, ['--patch', 'C:\\tmp\\p.yml']);
  await service.close();
});

test('a new session also adopts the DSH-side thinking level', async () => {
  const { service } = harness({ defaultSelection: () => ({ provider: 'p', model: 'm1', reasoningEffort: 'off' }) });
  await service.modelCatalog(PROJECT);
  const thinking = await service.thinkingOption(PROJECT);
  assert.equal(thinking.currentValue, 'off');
  await service.close();
});

test('a resumed session keeps the model the person chose, not the DSH default', async () => {
  const store = memoryStore();
  const first = harness({ store, emptyList: true, defaultSelection: () => ({ provider: 'q', model: 'q1' }) });
  await first.service.modelCatalog(PROJECT);
  await first.service.selectModel(PROJECT, { provider: 'p', model: 'm2' });
  await first.service.close();

  const second = harness({
    store, emptyList: true, startModel: '["p","m2"]',
    defaultSelection: () => ({ provider: 'q', model: 'q1' }),
  });
  const catalog = await second.service.modelCatalog(PROJECT);
  assert.deepEqual(catalog.default, { provider: 'p', model: 'm2' }, 'the session selection survives the resume');
  await second.service.close();
});

test('model and thinking selections go through ACP config options', async () => {
  const { service } = harness();
  const selected = await service.selectModel(PROJECT, { provider: 'q', model: 'q1' });
  assert.equal(selected.ok, true);
  assert.equal(JSON.parse(selected.currentValue)[1], 'q1');

  const thinking = await service.thinkingOption(PROJECT);
  assert.equal(thinking.id, 'thinking');
  assert.deepEqual(thinking.options.map(option => option.value), ['off', 'high']);

  const applied = await service.selectThinking(PROJECT, 'off');
  assert.equal(applied.ok, true);
  await assert.rejects(service.selectThinking(PROJECT, 'nope'), error => error.code === 'OFFICIAL_AGENT_INPUT');
  await assert.rejects(service.selectModel(PROJECT, { provider: 'p', model: 'missing' }), error => error.code === 'OFFICIAL_AGENT_MODEL_UNAVAILABLE');
  await service.close();
});

test('a model that declares no image input gets reference paths instead of image blocks', async () => {
  const { service, events } = harness({ image: false });
  await service.send(PROJECT, {
    key: 'k', turnId: 't', text: 'look',
    images: [{ mediaType: 'image/png', data: Buffer.from('fake').toString('base64') }],
  });
  const message = updatesOf(events).find(update => update.sessionUpdate === 'agent_message_chunk');
  assert.match(message.content.text, /blocks:text/);
  assert.equal(updatesOf(events).some(update => update.content?.type === 'image'), false);
  await service.close();
});

test('an image-capable route sends the inline picture', async () => {
  const { service, events } = harness({ image: true });
  await service.send(PROJECT, {
    key: 'k', turnId: 't', text: 'look',
    images: [{ mediaType: 'image/png', data: Buffer.from('fake').toString('base64') }],
  });
  const message = updatesOf(events).find(update => update.sessionUpdate === 'agent_message_chunk');
  assert.match(message.content.text, /blocks:image,text/);
  await service.close();
});

test('a permission request is asked through the approvals coordinator', async () => {
  const asked = [];
  const { service } = harness({
    approvals: {
      request: async input => { asked.push(input); return 'allowed-once'; },
      answerRequest: () => true,
      close: () => {},
    },
  });
  const result = await service.send(PROJECT, { key: 'k', turnId: 't', text: 'go' });
  assert.equal(result.stopReason, 'end_turn');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].projectId, PROJECT);
  assert.equal(asked[0].key, 'k');
  assert.equal(asked[0].toolName, 'write');
  assert.equal(service.answerPermission(PROJECT, { key: 'k', requestId: 'r', optionId: 'allow-once' }).ok, true);
  await service.close();
});

test('a refused permission answers the agent instead of hanging the turn', async () => {
  const asked = [];
  const { service } = harness({ approvals: { request: async input => { asked.push(input); return 'rejected'; }, answerRequest: () => true, close: () => {} } });
  const result = await service.send(PROJECT, { key: 'k', turnId: 't', text: 'go' });
  assert.equal(asked.length, 1);
  assert.ok(['end_turn', 'cancelled'].includes(result.stopReason), 'the agent decides; we never leave it waiting');
  await service.close();
});

test('cancel reaches the agent and a second concurrent turn is refused by name', async () => {
  const { service } = harness({ mode: 'hang-on-prompt' });
  const first = service.send(PROJECT, { key: 'k', turnId: 't1', text: 'go' }).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 60));
  await assert.rejects(service.send(PROJECT, { key: 'k', turnId: 't2', text: 'again' }), error => error.code === 'OFFICIAL_AGENT_BUSY');
  const cancelled = await service.cancel(PROJECT);
  assert.equal(cancelled.ok, true);
  await first;
  await service.close();
});

test('without an approvals coordinator a permission request is refused, not auto-allowed', async () => {
  let handler = null;
  const service = createAcpAgentService({
    verifier: async projectId => ({ projectId, path: 'C:\\fake' }),
    store: memoryStore(),
    emit: () => true,
    createClient: () => ({
      onUpdate() {},
      on() {},
      setPermissionHandler(fn) { handler = fn; },
      async start() { return { agentCapabilities: { promptCapabilities: { image: false } } }; },
      async newSession() { return { sessionId: 'session-x', configOptions: [] }; },
      async resumeSession() { return { sessionId: 'session-x', configOptions: [] }; },
      async listSessions() { return { sessions: [] }; },
      async setConfigOption() { return { configOptions: [] }; },
      async prompt() { return { stopReason: 'end_turn' }; },
      async close() {},
      cancel() {},
    }),
  });
  await service.modelCatalog(PROJECT).catch(() => {});
  assert.equal(typeof handler, 'function');
  assert.equal(await handler({ toolCall: { title: 'Write' } }), null);
  await service.close();
});

test('a model overlay the agent cannot serve is dropped instead of failing the panel', async () => {
  const made = [];
  const logs = [];
  const closed = [];
  const MODEL = 'C:\\temp\\model.yml';
  const TAP = 'C:\\temp\\tap.yml';
  const service = createAcpAgentService({
    verifier: async projectId => ({ projectId, path: 'C:\\fake' }),
    store: memoryStore(),
    emit: () => true,
    log: (event, fields) => logs.push({ event, fields }),
    onClosed: projectId => closed.push(projectId),
    spawnArgs: async () => ({ model: MODEL, tap: TAP }),
    createClient: options => {
      made.push(options);
      return createAcpClient({
        resolve: () => ({ command: process.execPath, args: [fixture] }),
        ...(options?.args ? { args: options.args } : {}),
        env: { ...process.env, FAKE_ACP_REFUSE_PATCH: '1', FAKE_ACP_REFUSE_PATCH_FILE: MODEL, ...(options?.env ?? {}) },
        requestTimeoutMs: 5000,
        spawnChild: (command, args, spawnOptions) => spawn(command, args, spawnOptions),
      });
    },
  });
  const catalog = await service.modelCatalog(PROJECT);
  assert.ok(catalog.groups.length > 0);
  assert.equal(made.length, 2, 'the overlay child and the fallback child');
  assert.deepEqual(made[0].args, ['--patch', MODEL, '--patch', TAP]);
  // The model overlay goes, the tap stays: sharing one array here is exactly how a
  // model fallback silently turned every answer back into committed paragraphs.
  assert.deepEqual(made[1].args, ['--patch', TAP]);
  assert.ok(logs.some(entry => entry.event === 'acp-model-fallback'));
  // The replaced child exits on purpose; that must not close the live Session.
  assert.deepEqual(closed, []);
  assert.equal(service.sessionOf(PROJECT), 'session-fake-1');
  await service.close();
});

test('a turn reports the live frames it received, and names a silent turn', async () => {
  const build = ({ stream, tap }) => {
    const logs = [];
    const events = [];
    const service = createAcpAgentService({
      verifier: async projectId => ({ projectId, path: 'C:\\fake' }),
      store: memoryStore(),
      emit: (projectId, event) => { events.push(event); return true; },
      log: (event, fields) => logs.push({ event, fields }),
      spawnArgs: async () => (tap ? { tap } : {}),
      createClient: options => createAcpClient({
        resolve: () => ({ command: process.execPath, args: [fixture] }),
        ...(options?.args ? { args: options.args } : {}),
        env: { ...process.env, ...(stream ? { FAKE_ACP_STREAM: '1' } : {}), ...(options?.env ?? {}) },
        requestTimeoutMs: 5000,
        spawnChild: (command, args, spawnOptions) => spawn(command, args, spawnOptions),
      }),
    });
    return { service, logs, events };
  };

  const live = build({ stream: true, tap: 'C:\\temp\\tap.yml' });
  await live.service.send(PROJECT, { key: 'k', turnId: 't1', text: 'hi' });
  // The counters are logged one tick after the turn so the child's last socket frames
  // can drain first; wait for that line instead of guessing.
  for (let attempt = 0; attempt < 40 && !live.logs.some(entry => entry.event === 'acp-stream'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const line = live.logs.find(entry => entry.event === 'acp-stream');
  assert.ok(line, 'the turn says what the live channel delivered');
  assert.equal(line.fields.deltas, 3, 'one thought delta and two text deltas');
  assert.equal(line.fields.syncs, 1);
  assert.equal(line.fields.seals, 1);
  assert.equal(line.fields.textCommits, 1);
  assert.equal(line.fields.connected, true);
  assert.ok(!live.logs.some(entry => entry.event === 'acp-stream-silent'));
  assert.ok(live.events.some(event => event.kind === 'stream'), 'the page receives the frames');
  const diagnose = live.service.diagnose(PROJECT);
  assert.equal(diagnose.stream.connected, true);
  assert.equal(diagnose.stream.deltas, 3);
  await live.service.close();

  const silent = build({ stream: false, tap: undefined });
  await silent.service.send(PROJECT, { key: 'k', turnId: 't1', text: 'hi' });
  for (let attempt = 0; attempt < 40 && !silent.logs.some(entry => entry.event === 'acp-stream-silent'); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const warning = silent.logs.find(entry => entry.event === 'acp-stream-silent');
  assert.equal(warning?.fields.reason, 'tap-absent', 'a child without the tap is named, not silently degraded');
  await silent.service.close();
});

test('a stored Session is resumed after restart even when the overlay model is unavailable', async () => {
  const logs = [];
  const closed = [];
  const store = memoryStore({ [PROJECT]: { sessionId: 'session-fake-1', cwd: 'C:\\fake' } });
  const service = createAcpAgentService({
    verifier: async projectId => ({ projectId, path: 'C:\\fake' }),
    store,
    emit: () => true,
    log: (event, fields) => logs.push({ event, fields }),
    onClosed: projectId => closed.push(projectId),
    spawnArgs: async () => ({ model: 'C:\\temp\\model.yml' }),
    createClient: options => createAcpClient({
      resolve: () => ({ command: process.execPath, args: [fixture] }),
      ...(options?.args ? { args: options.args } : {}),
      env: { ...process.env, FAKE_ACP_REFUSE_PATCH: '1', ...(options?.env ?? {}) },
      requestTimeoutMs: 5000,
      spawnChild: (command, args, spawnOptions) => spawn(command, args, spawnOptions),
    }),
  });
  const catalog = await service.modelCatalog(PROJECT);
  assert.ok(catalog.groups.length > 0);
  assert.ok(logs.some(entry => entry.event === 'acp-resume-failed'));
  assert.ok(logs.some(entry => entry.event === 'acp-model-fallback'));
  assert.ok(!logs.some(entry => entry.event === 'acp-session'), 'a resume must not be reported as a new Session');
  assert.equal(service.sessionOf(PROJECT), 'session-fake-1');
  assert.deepEqual(closed, []);
  await service.close();
});

test('sessionState says whether the conversation was reopened or started fresh', async () => {
  // Fresh: a new Session.
  const fresh = createAcpAgentService({
    verifier: async projectId => ({ projectId, path: 'C:\\fake' }),
    store: memoryStore(),
    emit: () => true,
    createClient: options => createAcpClient({
      resolve: () => ({ command: process.execPath, args: [fixture] }),
      ...(options?.args ? { args: options.args } : {}),
      env: { ...process.env, ...(options?.env ?? {}) },
      requestTimeoutMs: 5000,
      spawnChild: (command, args, spawnOptions) => spawn(command, args, spawnOptions),
    }),
  });
  assert.equal(fresh.sessionState(PROJECT), undefined);
  await fresh.modelCatalog(PROJECT);
  assert.deepEqual(fresh.sessionState(PROJECT), { sessionId: 'session-fake-1', resumed: false });
  await fresh.close();

  // Stored: the same Session is reopened.
  const resumed = createAcpAgentService({
    verifier: async projectId => ({ projectId, path: 'C:\\fake' }),
    store: memoryStore({ [PROJECT]: { sessionId: 'session-fake-1', cwd: 'C:\\fake' } }),
    emit: () => true,
    createClient: options => createAcpClient({
      resolve: () => ({ command: process.execPath, args: [fixture] }),
      ...(options?.args ? { args: options.args } : {}),
      env: { ...process.env, ...(options?.env ?? {}) },
      requestTimeoutMs: 5000,
      spawnChild: (command, args, spawnOptions) => spawn(command, args, spawnOptions),
    }),
  });
  await resumed.modelCatalog(PROJECT);
  assert.deepEqual(resumed.sessionState(PROJECT), { sessionId: 'session-fake-1', resumed: true });
  await resumed.close();
});
