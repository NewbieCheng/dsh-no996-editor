import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transform } from 'esbuild';
import { officialFacadeSource } from '../src/official/official-facade.mjs';

function setup({ promptResult = { ok: true }, EventSourceAvailable = true, recoveryMs, invoke, pathname = '/projects/project1' } = {}) {
  const sources = [], calls = [], events = [], timers = new Map();
  // A rejected mocked RPC may be supplied before start's async setup completes.
  if (promptResult && typeof promptResult.catch === 'function') promptResult.catch(() => {});
  let nextTimer = 0;
  class MockEventSource {
    constructor(url) { this.url = url; this.readyState = 0; this.handlers = {}; sources.push(this); }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    open() { this.readyState = 1; }
    ready() { this.handlers.ready?.({ data: '{}' }); }
    error() { this.readyState = 0; this.onerror?.({}); }
    message(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.readyState = 2; }
  }
  const factory = runInNewContext(officialFacadeSource, { EventSource: EventSourceAvailable ? MockEventSource : undefined,
    // The facade reads the project from the page's own address (`running`, `start`).
    location: { pathname },
    // Kept with their delay so a test can fire only the ones that are due: the
    // recovery retry is short, the "terminal missing" guard is fifteen seconds.
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms: Number(ms) || 0 }); return id; },
    clearTimeout: id => timers.delete(id) });
  const facade = factory({
    ...(recoveryMs === undefined ? {} : { recoveryMs }),
    invoke: invoke ?? (async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === 'agent:prompt') return await promptResult;
      if (channel === 'agent:cancel') return { ok: true };
      return null;
    }),
  });
  facade.localAgents.onEvent(event => events.push(event));
  return {
    facade, sources, calls, events,
    fireTimers: (upToMs = Infinity) => {
      for (const [id, timer] of [...timers]) {
        if (timer.ms > upToMs) continue;
        timers.delete(id);
        timer.fn();
      }
    },
  };
}
async function start(env) {
  const pending = env.facade.localAgents.start('deepseek', '', null, { projectId: 'project1' });
  // Current start waits for SSE before attach; complete that initial handshake.
  const initial = env.sources[0];
  if (initial) { initial.open(); initial.ready(); }
  const { key } = await pending;
  // Each prompt test exercises its own reconnect/admission handshake below.
  if (initial) { initial.error(); env.sources.length = 0; }
  return key;
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const done = (key, turnId, extra = {}) => ({ key, turnId, kind: 'done', ok: true, stopReason: 'end_turn', ...extra });

test('a reloaded page adopts the running turn and its key instead of prompting again', async () => {
  const adopted = { ok: true, sessionId: 'conv-1', resumed: true, key: 'page-old', activeTurn: { turnId: 't9', key: 'page-old' } };
  const env = setup({
    invoke: async (channel) => (channel === 'agent:attach' ? adopted : null),
  });
  const pending = env.facade.localAgents.start('deepseek', '', 'conv-1', { projectId: 'project1' });
  const initial = env.sources[0];
  initial.open(); initial.ready();
  const started = await pending;
  assert.equal(started.key, 'page-old', 'the adopted turn keeps the key its events carry');
  assert.equal(started.info.activeTurn?.turnId, 't9');
  assert.equal(started.info.sessionId, 'conv-1', 'the conversation is still the one it was');
  assert.equal(env.calls.some(x => x.channel === 'agent:prompt'), false, 'adoption never sends a prompt');
});

test('RPC success cannot overtake ordered updates and matching terminal', async () => {
  const env = setup(), key = await start(env);
  let settled = false;
  const pending = env.facade.localAgents.prompt(key, 'hello', { turnId: 't1' }).then(value => { settled = true; return value; });
  const source = env.sources[0]; source.open();
  await tick(); assert.equal(env.calls.filter(x => x.channel === 'agent:prompt').length, 0);
  source.ready(); await tick(); assert.equal(settled, false);
  source.message(done(key, 'other')); assert.equal(settled, false);
  source.message({ key, kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } });
  source.message(done(key, 't1'));
  assert.equal((await pending).stopReason, 'end_turn');
  assert.deepEqual(env.events.map(x => x.kind), ['update', 'done']);
});

test('an upstream example reference survives the draft and reaches the Host prompt', { skip: !process.env.OPENFILM_SOURCE && 'set OPENFILM_SOURCE to the pinned OpenFilm checkout' }, async () => {
  const source = await readFile(join(process.env.OPENFILM_SOURCE, 'apps/desktop/chat/src/studio-refs.ts'), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'esm' });
  const refs = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
  const example = { kind: 'example', id: 'example-one', title: 'Example One', url: 'https://example.test/film', start: 2, end: 4, segment: 'opening' };
  const pill = refs.refPill(undefined, example);
  const restored = refs.refFromPill(JSON.parse(JSON.stringify(pill)));
  assert.equal(restored.id, example.id);
  assert.equal(restored.start, 2);
  const text = `Follow this reference [1]${refs.studioReferencesText([restored])}`;
  const env = setup(), key = await start(env);
  const pending = env.facade.localAgents.prompt(key, text, { turnId: 'reference-turn' });
  const sourceStream = env.sources[0]; sourceStream.open(); sourceStream.ready(); await tick();
  const sent = env.calls.find(call => call.channel === 'agent:prompt');
  assert.equal(sent.payload.projectId, 'project1');
  assert.equal(sent.payload.text, text);
  assert.match(sent.payload.text, /Example One/);
  assert.match(sent.payload.text, /https:\/\/example\.test\/film/);
  assert.match(sent.payload.text, /2\.000–4\.000 s/);
  sourceStream.message(done(key, 'reference-turn'));
  await pending;
});

test('terminal can precede RPC and preserves failure or cancellation', async () => {
  for (const terminal of [{ ok: false, error: 'model failed' }, { ok: true, stopReason: 'cancelled' }]) {
    let finish; const rpc = new Promise(resolve => { finish = resolve; });
    const env = setup({ promptResult: rpc }), key = await start(env);
    const pending = env.facade.localAgents.prompt(key, 'hello', { turnId: 't1' });
    const source = env.sources[0]; source.open(); source.ready(); await tick();
    source.message(done(key, 't1', terminal));
    const result = await pending;
    assert.equal(result.ok, terminal.ok);
    if (!terminal.ok) assert.equal(result.error, 'model failed');
    else assert.equal(result.stopReason, 'cancelled');
    finish({ ok: true });
  }
});

test('missing terminal after RPC completion fails visibly instead of hanging', async () => {
  const env = setup(), key = await start(env);
  const pending = env.facade.localAgents.prompt(key, 'hello', { turnId: 't1' });
  env.sources[0].open(); env.sources[0].ready();
  await tick();
  env.fireTimers();
  await assert.rejects(pending, /terminal missing/);
  assert.equal(env.events.length, 0);
});

test('a brief drop resumes the same turn from the last applied sequence', async () => {
  const env = setup(), key = await start(env);
  const pending = env.facade.localAgents.prompt(key, 'hello', { turnId: 't1' });
  const source = env.sources[0];
  source.open(); source.ready(); await tick();
  source.message({ key, kind: 'update', seq: 5, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'half' } } });
  source.error();
  // The page did not give up: it scheduled a reconnect that names the cursor.
  env.fireTimers(1000);
  const resumed = env.sources[1];
  assert.ok(resumed, 'a reconnect was attempted');
  assert.match(resumed.url, /afterSeq=5/);
  resumed.open(); resumed.ready(); await tick();
  resumed.message(done(key, 't1'));
  assert.equal((await pending).stopReason, 'end_turn');
  assert.equal(env.calls.filter(x => x.channel === 'agent:prompt').length, 1, 'the prompt is never sent twice');
  assert.equal(env.events.filter(x => x.kind === 'done').length, 1);
});

test('a drop that never recovers fails visibly instead of inventing done', async () => {
  const env = setup({ recoveryMs: 40 }), key = await start(env);
  const pending = env.facade.localAgents.prompt(key, 'hello', { turnId: 't1' });
  const source = env.sources[0]; source.open(); source.ready(); await tick();
  source.error();
  env.fireTimers(1000);
  await new Promise(resolve => setTimeout(resolve, 60)); // past the recovery budget
  const retry = env.sources[1];
  assert.ok(retry, 'it retried once before giving up');
  retry.error();
  await assert.rejects(pending, /stream disconnected/);
  assert.equal(env.events.filter(x => x.kind === 'done').length, 0);
});

test('a turn that ended while the stream was down is reconciled with the Host', async () => {
  const env = setup({
    invoke: async (channel) => {
      if (channel === 'agent:prompt') return { ok: true };
      if (channel === 'agent:turn-state') return { known: true, active: false, turnId: null, lastSettled: { turnId: 't1', ok: true, stopReason: 'end_turn' } };
      return null;
    },
  });
  const key = await start(env);
  const pending = env.facade.localAgents.prompt(key, 'hello', { turnId: 't1' });
  const source = env.sources[0]; source.open(); source.ready(); await tick();
  source.error();
  env.fireTimers(1000);
  const resumed = env.sources[1];
  resumed.open(); resumed.ready(); await tick(); await tick();
  assert.equal((await pending).stopReason, 'end_turn', 'the answer that finished is not left running');
  assert.equal(env.events.filter(x => x.kind === 'done').length, 1);
});

test('RPC rejection is visible without a terminal', async () => {
  const env = setup({ promptResult: Promise.reject(new Error('admission refused')) }), key = await start(env);
  const pending = env.facade.localAgents.prompt(key, 'hello', { turnId: 't1' });
  env.sources[0].open(); env.sources[0].ready();
  await assert.rejects(pending, /admission refused/);
  assert.equal(env.events.length, 0);
});

test('missing source and readiness timeout fail closed', async () => {
  const absent = setup({ EventSourceAvailable: false }), key1 = await start(absent);
  await assert.rejects(absent.facade.localAgents.prompt(key1, 'hello'), /agent.events/);
  const env = setup(), key = await start(env);
  const pending = env.facade.localAgents.prompt(key, 'hello');
  env.sources[0].open(); env.fireTimers();
  await assert.rejects(pending, /agent.events/);
  assert.equal(env.calls.filter(x => x.channel === 'agent:prompt').length, 0);
});

test('cancel while running does not manufacture a terminal', async () => {
  let finish; const rpc = new Promise(resolve => { finish = resolve; });
  const env = setup({ promptResult: rpc }), key = await start(env);
  const pending = env.facade.localAgents.prompt(key, 'hello', { turnId: 't1' });
  env.sources[0].open(); env.sources[0].ready(); await tick();
  await env.facade.localAgents.cancel(key);
  assert.equal(env.events.length, 0);
  env.sources[0].message(done(key, 't1', { stopReason: 'cancelled' }));
  assert.equal((await pending).stopReason, 'cancelled');
  finish({ ok: true });
});

test('cancel before ready never dispatches prompt', async () => {
  const env = setup(), key = await start(env);
  const pending = env.facade.localAgents.prompt(key, 'hello', { turnId: 't1' });
  await env.facade.localAgents.cancel(key);
  assert.equal((await pending).stopReason, 'cancelled');
  env.sources[0].open(); env.sources[0].ready(); await tick();
  assert.equal(env.calls.filter(x => x.channel === 'agent:prompt').length, 0);
});
// The permission row: it has to reach the composer menu, and it must not invent a
// preset the Host never applied.
test('the permission row carries the Host preset and a real choice', async () => {
  const sources = [];
  const calls = [];
  const factory = runInNewContext(officialFacadeSource, { EventSource: undefined, setTimeout: () => 0, clearTimeout: () => {} });
  const facade = factory({ invoke: async (channel, payload) => {
    calls.push({ channel, payload });
    if (channel === 'agent:permission') return { current: 'danger-full-access', decided: 'danger-full-access', available: true };
    if (channel === 'agent:permission-set') return { ok: true, preset: payload.preset, applied: true };
    if (channel === 'agent:models') return { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }] };
    return null;
  } });
  const started = await facade.localAgents.start('deepseek', '', null, { projectId: 'project1' });
  const option = (started.info?.configOptions || []).find(o => o && o.category === 'permission');
  assert.ok(option, `expected a permission option, got ${JSON.stringify(started.configOptions)}`);
  assert.equal(option.currentValue, 'danger-full-access');
  // Values come from the vm realm, so compare textually rather than by prototype identity.
  assert.equal(option.options.map(o => o.value).join(','), 'danger-full-access,workspace-write');
  // Choosing it goes to the Host's own setter, not to a page-local pref.
  await facade.localAgents.setOption(started.key, 'permission', 'workspace-write');
  const set = calls.filter(c => c.channel === 'agent:permission-set').pop();
  assert.equal(set?.payload?.preset, 'workspace-write');
  assert.equal(sources.length, 0);
});

test('no applied preset means no permission row', async () => {
  const factory = runInNewContext(officialFacadeSource, { EventSource: undefined, setTimeout: () => 0, clearTimeout: () => {} });
  const facade = factory({ invoke: async (channel) => {
    if (channel === 'agent:permission') return { current: null, available: false };
    return null;
  } });
  const started = await facade.localAgents.start('deepseek', '', null, { projectId: 'project1' });
  assert.equal((started.info?.configOptions || []).some(o => o && o.category === 'permission'), false);
});
// The row must not disappear when the Host reports a preset this build does not name.
// It went missing entirely (person: "缺少选择权限") whenever the preset failed to
// resolve, because the builder returned null for any `current` it did not list.
test('an unknown current preset still draws the permission row', async () => {
  const env = setup();
  env.calls.length = 0;
  const factoryCalls = [];
  const facade = runInNewContext(officialFacadeSource, { EventSource: class { close() {} } })({
    invoke: async (channel, payload) => {
      factoryCalls.push({ channel, payload });
      if (channel === 'agent:permission') return { current: 'read-only', decided: 'read-only', available: true };
      return null;
    },
  });
  const started = await facade.localAgents.start('deepseek', '', null, { projectId: 'project1' });
  const option = (started.info?.configOptions || []).find(o => o && o.category === 'permission');
  assert.ok(option, `expected a permission option, got ${JSON.stringify(started.configOptions)}`);
  assert.equal(option.currentValue, 'read-only');
  assert.equal(option.options.map(o => o.value).join(','), 'danger-full-access,workspace-write,read-only');
});
// After a reload the shell asks what this project still runs. The answer decides
// whether a turn is put back or a second prompt is sent into BUSY.
test('running() puts back only well-formed turns of this project', async () => {
  const seen = [];
  const env = setup({
    pathname: '/projects/project1',
    invoke: async (channel, payload) => {
      seen.push({ channel, payload });
      if (channel !== 'agent:running') return null;
      return [
        { key: 'dsh-a', agent: 'deepseek', cwd: 'C:/film', meta: { turnId: 't1', prompt: 'hi' }, done: null, events: [{ kind: 'thinking' }] },
        { key: 'dsh-b', meta: { turnId: 't2' } },
        { key: 42, meta: { turnId: 't3' } },
        { key: 'dsh-c' },
        'nonsense',
      ];
    },
  });
  const list = await env.facade.localAgents.running();
  assert.deepEqual(seen.map(call => call.channel), ['agent:running']);
  assert.equal(seen[0].payload.projectId, 'project1');
  assert.equal(list.length, 2, 'bad keys and entries without a turn meta are dropped');
  assert.equal(list[0].key, 'dsh-a');
  assert.equal(list[0].cwd, 'C:/film');
  assert.deepEqual(JSON.parse(JSON.stringify(list[0].events)), [{ kind: 'thinking' }]);
  assert.equal(list[1].agent, 'deepseek', 'a missing agent is named, not guessed per turn');
  assert.equal(list[1].cwd, '');
});

test('running() answers [] outside a project page, or when the Host refuses', async () => {
  const offProject = setup({ pathname: '/' });
  assert.equal((await offProject.facade.localAgents.running()).length, 0);
  assert.equal(offProject.calls.length, 0, 'no project means no RPC');

  const refused = setup({ pathname: '/projects/project1', invoke: async () => { throw new Error('denied'); } });
  assert.equal((await refused.facade.localAgents.running()).length, 0);
});
