import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnosticLog } from '../src/host/diagnostic-log.mjs';
import { createDshNativeAgentService } from '../src/native/dsh-native-agent-service.mjs';
import { createOfficialChatRpc } from '../src/official/official-chat-rpc.mjs';
import { startStudioProxy } from '../src/studio/studio-proxy.mjs';
import { createDiagLogsController } from '../src/studio/studio-controller/routes/diag-logs.mjs';

const KEY = 'd'.repeat(48);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('selectThinking mismatch logs pinpointed model/requested/allowed detail with traceId while keeping safe 503 response', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'no996-rpc-diag-'));
  const up = createServer((_req, res) => { res.writeHead(200).end('{}'); });
  const filmUp = createServer((_req, res) => { res.writeHead(200).end(''); });
  const upPort = await listen(up);
  const filmPort = await listen(filmUp);

  const diagLog = createDiagnosticLog({ dir });
  const ctx = {
    sessionController: {
      modelCatalog: async () => ({
        default: { provider: 'deepseek', model: 'deepseek-chat' },
        groups: [{
          id: 'deepseek',
          models: [{ id: 'deepseek-chat', name: 'DeepSeek', reasoning: { efforts: ['off', 'low', 'medium'], defaultEffort: 'medium' } }],
        }],
      }),
      selectModel: async () => {},
      projections: async () => null,
      create: async () => ({ sessionId: 'sess-1' }),
      prompt: async () => {},
      cancel: async () => {},
      follow: async function* () {},
    },
    on: () => () => {},
    get: () => null,
  };

  const agent = createDshNativeAgentService({
    ctx,
    verifier: async (projectId) => ({ projectId, path: dir }),
    store: { get: () => undefined, set: () => {}, getSession: () => undefined, setSession: () => {} },
    emit: () => true,
    diag: diagLog,
  });

  const rpc = createOfficialChatRpc(
    { load: async () => ({ sessions: [], last: null, turns: [], revision: 0 }), saveSessions: async () => 1, saveTurn: async () => 1 },
    agent,
  );

  const prevPort = process.env.NO996_OPENFILM_EDITOR_PORT;
  process.env.NO996_OPENFILM_EDITOR_PORT = '0';
  const proxy = await startStudioProxy({
    upstream: { origin: `http://127.0.0.1:${upPort}`, filmOrigin: `http://localhost:${filmPort}`, key: KEY },
    authenticateBrowser: () => true,
    webOrigin: 'http://127.0.0.1:5999',
    officialShell: true,
    officialRpc: rpc,
    authorizeOfficialProject: async () => true,
    attachOfficialEvents: async () => {},
    diagLog,
  });
  if (prevPort === undefined) delete process.env.NO996_OPENFILM_EDITOR_PORT;
  else process.env.NO996_OPENFILM_EDITOR_PORT = prevPort;

  t.after(async () => {
    await proxy.close();
    diagLog.close();
    await Promise.all([new Promise(r => up.close(r)), new Promise(r => filmUp.close(r))]);
    rmSync(dir, { recursive: true, force: true });
  });

  const origin = proxy.bootstrapData().editorOrigin;
  const response = await fetch(`${origin}/__dsh/official-rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      'sec-fetch-site': 'same-origin',
      'x-no996-trace-id': 'ui-trace-test1',
    },
    body: JSON.stringify({
      channel: 'agent:select-thinking',
      payload: { projectId: 'proj1234', value: 'max' },
    }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-no996-trace-id'), 'ui-trace-test1');
  const body = await response.text();
  assert.equal(body, 'OFFICIAL_AGENT_INPUT: 请求内容无效 (agent:select-thinking)');

  await diagLog.flush();
  const listed = await diagLog.list({ traceId: 'ui-trace-test1' });
  assert.equal(listed.total, 1);
  const entry = listed.items[0];
  assert.equal(entry.code, 'OFFICIAL_AGENT_INPUT');
  assert.equal(entry.channel, 'agent:select-thinking');
  assert.equal(entry.location, 'src/native/dsh-native-agent-service.mjs:selectThinking');
  assert.equal(entry.detail.model, 'deepseek/deepseek-chat');
  assert.equal(entry.detail.requestedValue, 'max');
  assert.deepEqual(entry.detail.allowedValues, ['off', 'low', 'medium']);
});

test('diag:list/export/prefs/clear and /__dsh/client-diag enforce auth and work end-to-end', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'no996-diag-ctl-'));
  const diagLog = createDiagnosticLog({ dir });
  const routes = [];
  const BROWSER = { id: 'browser' };
  const ctl = createDiagLogsController({
    ctx: { connection: { admit: () => ({ peer: BROWSER }), browserPeer: BROWSER }, get: () => null },
    register: (r) => { routes.push(r); return () => {}; },
    track: (d) => d,
    diagLog,
    pluginLog: { tail: () => [{ at: '2026-11-18T00:00:00Z', level: 'info', event: 'host-start' }] },
    preferences: { set: async (patch) => ({ logRetentionDays: patch.logRetentionDays }) },
    runtime: { health: async () => ({ running: true, port: 4747 }) },
    agentService: null,
    pluginVersion: '0.15.33',
    openfilmVersion: '0.3.2',
    officialShell: true,
  });

  t.after(() => {
    diagLog.close();
    rmSync(dir, { recursive: true, force: true });
  });

  diagLog.error({ layer: 'ui', code: 'JS_ERROR', traceId: 't-1', location: 'App.tsx:42', summary: 'boom' });
  await diagLog.flush();

  const prefsRes = await ctl.handleRpc('diag:prefs', { retentionDays: 30 });
  assert.equal(prefsRes.retentionDays, 30);

  const exported = await ctl.handleRpc('diag:export', {});
  assert.equal(exported.environment.pluginVersion, '0.15.33');
  assert.match(exported.markdown, /App\.tsx:42/);
  assert.match(exported.markdown, /t-1/);

  const cleared = await ctl.handleRpc('diag:clear', { mode: 'all' });
  assert.equal(cleared.mode, 'all');
  const after = await ctl.handleRpc('diag:list', {});
  assert.equal(after.total, 0);
  assert.ok(routes.some(r => r.path === '/api/no996-openfilm/logs'));
  assert.ok(routes.some(r => r.path === '/api/no996-openfilm/client-diag'));
});
