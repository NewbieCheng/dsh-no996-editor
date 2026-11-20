// The environment route is the inspectable surface for "what can the film
// agent load": preset, isolated skills, film tools, per-project chain.
// Read-only by construction: no model call, no file write, every probe
// degrades to a named field.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createEnvironmentRoute } from '../src/studio/studio-controller/routes/environment.mjs';

const BROWSER = { id: 'browser' };
const PATH = '/api/no996-openfilm/environment';

function fakeRes() {
  return {
    headers: {}, status: 0, body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); return this; },
    end(body) { if (body !== undefined) this.body = body; },
  };
}

function mount(overrides = {}) {
  const routes = [];
  const deps = {
    ctx: { connection: { admit: () => ({ peer: BROWSER }), browserPeer: BROWSER }, get: () => null },
    register: route => { routes.push(route); return () => {}; },
    track: dispose => dispose,
    skillsDir: 'skills',
    filmTools: () => [
      { name: 'no996_guide', description: 'Read the manual' },
      { name: 'no996_clip', description: 'Change the timeline' },
    ],
    instructions: null,
    projectPathOf: null,
    activeTemplatesOf: null,
    ...overrides,
  };
  createEnvironmentRoute(deps);
  return routes.find(item => item.path === PATH);
}

const get = (projectId = '') => ({
  method: 'GET',
  headers: {},
  url: projectId ? `${PATH}?projectId=${projectId}` : PATH,
});

test('environment answers preset, isolated skills and film tools', async () => {
  const route = mount();
  const res = fakeRes();
  await route.handler(get(), res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.preset.ok, false, 'no registry means a named absence, not a throw');
  assert.equal(body.preset.detail, 'not registered');
  assert.ok(Array.isArray(body.skills.isolated), 'skills always lists, even on error');
  assert.ok(body.skills.isolated.some(skill => skill.id === 'openfilm-motion'), 'the motion skill is visible');
  assert.ok(body.tools.some(tool => tool.name === 'no996_clip'), 'film tools are listed');
  assert.equal(body.child.skills.includeDefaultRoots, false, 'the global catalog stays out');
  assert.equal(body.project, null, 'no projectId means global evidence only');
});

test('a named project adds its instruction chain', async () => {
  const route = mount({
    instructions: path => ({ persona: 300, files: [{ file: `${path}/AGENTS.md`, bytes: 100 }], root: path, outside: ['repo/AGENTS.md'], budget: { total: 400, limit: 6144, ok: true } }),
    projectPathOf: async () => '/films/demo',
    activeTemplatesOf: async () => ['sketchnote'],
  });
  const res = fakeRes();
  await route.handler(get('proj123456'), res);
  const body = JSON.parse(res.body);
  assert.equal(body.project.projectId, 'proj123456');
  assert.deepEqual(body.project.activeTemplates, ['sketchnote']);
  assert.equal(body.project.budget.ok, true);
});

test('a failing probe degrades that field only', async () => {
  const route = mount({ filmTools: () => { throw new Error('boom'); } });
  const res = fakeRes();
  await route.handler(get(), res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body).tools, []);
});

test('environment is GET-only and refuses a foreign peer', async () => {
  const route = mount();
  const post = fakeRes();
  await route.handler({ method: 'POST', headers: {}, url: PATH }, post);
  assert.equal(post.status, 405);
  const foreign = fakeRes();
  const foreignRoute = mount({ ctx: { connection: { admit: () => ({ peer: { id: 'other' } }), browserPeer: BROWSER }, get: () => null } });
  await foreignRoute.handler(get(), foreign);
  assert.equal(foreign.status, 403);
});

test('environment includes sanitized workbenchAuth when authStatus is supplied', async () => {
  const route = mount({
    authStatus: async () => ({ loggedIn: true, account: 'u@example.com', displayName: 'Tester', accessToken: 'secret' }),
  });
  const res = fakeRes();
  await route.handler(get(), res);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(body.workbenchAuth, {
    loggedIn: true,
    guest: false,
    dev: false,
    account: 'u@example.com',
    displayName: 'Tester',
  });
});
