// These routes used to live inside createStudioController, where every helper they
// named was in scope. Moving them out silently broke that: the first version read
// `basename`, `officialStore` and `deleteEditingProject` without importing or
// receiving them. Unit tests stayed green because no test called the route.
//
// So this test calls it: the GET path runs the whole list pipeline
// (bound sessions → buildEditingProjects → chat store → prefs) against stubs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditingRoutes } from '../src/studio/studio-controller/routes/editing.mjs';

const BROWSER = { id: 'browser' };

function fakeCtx() {
  return {
    connection: {
      admit: () => ({ peer: BROWSER }),
      browserPeer: BROWSER,
    },
  };
}

function fakeRes() {
  return {
    headers: {},
    status: 0,
    body: undefined,
    headersSent: false,
    writableEnded: false,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) {
      this.status = status;
      this.headersSent = true;
      Object.assign(this.headers, headers);
      return this;
    },
    end(body) {
      if (body !== undefined) this.body = body;
      this.writableEnded = true;
    },
  };
}

function mount(overrides = {}) {
  const routes = [];
  const deps = {
    ctx: fakeCtx(),
    register: route => { routes.push(route); return () => {}; },
    track: dispose => dispose,
    acpSessions: { all: () => [], remove() {} },
    archive: { isArchived: () => false, available: true },
    editingPrefs: { all: () => ({}), getSession: () => undefined, set: async () => ({}) },
    verifyOfficialProject: async () => ({ id: 'abcdef123456' }),
    listTemplates: async () => [],
    templatesRoot: '/templates',
    getLastProxy: () => null,
    officialStore: async () => ({ load: async () => ({ sessions: [] }) }),
    deleteEditingProject: async () => ({ ok: true }),
    getAcpAgentService: () => null,
    ...overrides,
  };
  createEditingRoutes(deps);
  return routes;
}

const routeOf = (routes, path) => routes.find(route => route.path === path);

test('the editing list answers with the projects the Host knows about', async () => {
  const routes = mount({
    acpSessions: {
      all: () => [{ projectId: 'abcdef123456', sessionId: 'session123', cwd: '/films/demo' }],
      remove() {},
    },
  });
  const route = routeOf(routes, '/api/no996-openfilm/editing-sessions');
  assert.ok(route, 'route is registered');

  const res = fakeRes();
  await route.handler({ method: 'GET', headers: {}, url: '/api/no996-openfilm/editing-sessions' }, res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.projects.length, 1);
  assert.equal(body.projects[0].name, 'demo', 'the row name falls back to the folder name');
  assert.equal(body.projects[0].sessions[0].sessionId, 'session123');
});

test('the editing list is GET-only', async () => {
  const routes = mount();
  const route = routeOf(routes, '/api/no996-openfilm/editing-sessions');
  const res = fakeRes();
  await route.handler({ method: 'POST', headers: {}, url: '/api/no996-openfilm/editing-sessions' }, res);
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'GET');
});

test('a failing dependency becomes 503, not an exception', async () => {
  const routes = mount({ getLastProxy: () => { throw new Error('no proxy'); } });
  const route = routeOf(routes, '/api/no996-openfilm/editing-sessions');
  const res = fakeRes();
  await route.handler({ method: 'GET', headers: {}, url: '/api/no996-openfilm/editing-sessions' }, res);
  assert.equal(res.status, 200, 'a missing proxy falls back to bound sessions');
});

test('every editing route refuses a foreign peer or the wrong method', async () => {
  const routes = mount({
    ctx: { connection: { admit: () => ({ peer: { id: 'someone-else' } }), browserPeer: BROWSER } },
  });
  assert.equal(routes.length, 6);
  for (const route of routes) {
    const res = fakeRes();
    await route.handler({ method: 'GET', headers: {}, url: route.path }, res);
    // POST-only routes answer 405 before admission; both are refusals.
    assert.ok(res.status >= 400, `${route.path} answered ${res.status}`);
  }
});

function requestTarget(sessionId) {
  return { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {
    yield Buffer.from(JSON.stringify({ sessionId }));
  } };
}

const targetRoute = overrides => routeOf(mount(overrides), '/api/no996-openfilm/editing-session-target');

test('workspace lookup returns the exact Studio row for a native session, not cached last', async () => {
  const loaded = [];
  const route = targetRoute({
    acpSessions: { all: () => [
      { sessionId: 'native-1', projectId: 'projectA', conversation: 'provider-a' },
      { sessionId: 'native-2', projectId: 'projectA', conversation: 'panel-b' },
      { sessionId: 'native-3', projectId: 'projectB', conversation: 'panel-a' },
    ] },
    archive: { isArchived: id => id === 'native-2' },
    officialStore: async () => ({ listSessions: async id => {
      loaded.push(id);
      return { last: 'panel-b', sessions: [{ id: 'panel-a', agentSessions: { deepseek: 'provider-a' } }, { id: 'panel-b' }] };
    } }),
  });
  for (const [native, target] of [
    ['native-1', { projectId: 'projectA', conversationId: 'panel-a', archived: false }],
    ['native-2', { projectId: 'projectA', conversationId: 'panel-b', archived: true }],
    ['native-4', null],
  ]) {
    const res = fakeRes();
    await route.handler(requestTarget(native), res);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { target });
  }
  assert.deepEqual(loaded, ['projectA', 'projectA']);
});

test('workspace lookup rejects ambiguous, stale, and unavailable targets without fallback', async () => {
  const row = { sessionId: 'native-1', projectId: 'projectA', conversation: 'panel-a' };
  const cases = [
    { all: () => [row, { ...row, projectId: 'projectB' }], load: () => assert.fail('ambiguous mapping looked up'), status: 409 },
    { all: () => [{ ...row, conversation: '' }], load: () => assert.fail('legacy mapping guessed'), status: 409 },
    { all: () => [row], load: async () => ({ last: 'panel-b', sessions: [{ id: 'panel-b' }] }), status: 409 },
    { all: () => [row], load: async () => ({ sessions: [{ id: 'panel-a' }, { id: 'panel-b', agentSessions: { deepseek: 'panel-a' } }] }), status: 409 },
    { all: () => [row], load: async () => { throw new Error('internal path'); }, status: 503 },
  ];
  for (const { all, load, status } of cases) {
    const route = targetRoute({ acpSessions: { all }, officialStore: async () => ({ listSessions: load }) });
    const res = fakeRes();
    await route.handler(requestTarget('native-1'), res);
    assert.equal(res.status, status);
    assert.doesNotMatch(res.body, /panel-b|internal path/);
  }
  let current = row;
  const route = targetRoute({
    acpSessions: { all: () => [current] },
    officialStore: async () => ({ listSessions: async () => {
      current = { ...row, projectId: 'projectB' };
      return { sessions: [{ id: 'panel-a' }] };
    } }),
  });
  const res = fakeRes();
  await route.handler(requestTarget('native-1'), res);
  assert.equal(res.status, 409);
});

test('workspace target checks the browser peer and payload before reading storage', async () => {
  const acpSessions = { all: () => assert.fail('storage accessed before validation') };
  const foreign = targetRoute({ acpSessions, ctx: { connection: { admit: () => ({ peer: { id: 'foreign' } }), browserPeer: BROWSER } } });
  const denied = fakeRes();
  await foreign.handler(requestTarget('native-1'), denied);
  assert.equal(denied.status, 403);
  const res = fakeRes();
  await targetRoute({ acpSessions }).handler(requestTarget('wrong/id'), res);
  assert.equal(res.status, 400);
});

test('bad conversation IDs and failed storage writes do not reset or unlink native sessions', async () => {
  let writes = 0;
  const routes = mount({
    officialStore: async () => ({ deleteConversations: async () => { writes++; throw new Error('write failed'); } }),
    getAcpAgentService: () => ({ reset: () => assert.fail('reset after failed delete') }),
    acpSessions: { remove: () => assert.fail('unlink after failed delete') },
    onConversationsDeleted: () => assert.fail('publish after failed delete'),
  });
  const route = routeOf(routes, '/api/no996-openfilm/editing-delete');
  for (const [sessionId, status] of [[null, 400], ['?', 400], ['session_1', 503]]) {
    const res = fakeRes();
    await route.handler({ method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ projectId: 'abcdef123456', sessionId }));
    } }, res);
    assert.equal(res.status, status);
  }
  assert.equal(writes, 1);
});

test('deleting one conversation unbinds its mapped agentSessions.deepseek key without touching other sessions', async () => {
  const removed = [];
  const archived = [];
  const saved = [];
  const reset = [];
  const events = [];
  const routes = mount({
    getAcpAgentService: () => ({ reset: () => assert.fail('whole project reset'), resetConversation: (_pid, id) => reset.push(id) }),
    onConversationsDeleted: receipt => events.push(receipt),
    acpSessions: {
      all: () => [],
      get: () => undefined,
      getSession: (pid, conv) => (pid === 'abcdef123456' && conv === 'dsh-conv-1' ? { sessionId: 'dsh-sess-1' } : undefined),
      remove: () => {},
      removeSession: (pid, conv) => { removed.push([pid, conv]); },
    },
    archive: {
      available: true,
      isArchived: () => false,
      archive: async sid => { archived.push(sid); },
    },
    officialStore: async () => ({
      deleteConversations: async (pid, id) => {
        saved.push([pid, id]);
        return { removed: [{ id, agentSessions: { deepseek: 'dsh-conv-1' } }], remaining: 1, revision: 5 };
      },
    }),
  });
  const route = routeOf(routes, '/api/no996-openfilm/editing-delete');
  const res = fakeRes();
  const payload = JSON.stringify({ projectId: 'abcdef123456', sessionId: 'session_1' });
  await route.handler({
    method: 'POST',
    headers: {},
    url: '/api/no996-openfilm/editing-delete',
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); },
  }, res);
  assert.equal(res.status, 200);
  const receipt = { projectId: 'abcdef123456', sessionId: 'session_1', revision: 5, remaining: 1 };
  assert.deepEqual(JSON.parse(res.body), { ok: true, ...receipt, cleanupPending: false });
  assert.deepEqual(removed, [['abcdef123456', 'session_1'], ['abcdef123456', 'dsh-conv-1']]);
  assert.deepEqual(archived, ['dsh-sess-1']);
  assert.deepEqual(reset, ['session_1', 'dsh-conv-1']);
  assert.deepEqual(events, [{ ...receipt, removedIds: ['session_1'] }]);
  assert.deepEqual(saved, [['abcdef123456', 'session_1']]);
});
