import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDshNativeAgentService } from '../src/native/dsh-native-agent-service.mjs';
import { createDshSessionStore } from '../src/native/dsh-session-store.mjs';
import { normalizeWorkModeState, promptPrefixForWorkMode } from '../src/native/work-mode.mjs';
import { createModeTool } from '../src/tools/mode-tool.mjs';

test('normalizeWorkModeState and promptPrefixForWorkMode enforce phase and autoExport contracts', () => {
  const auto = normalizeWorkModeState({ mode: 'auto', effective: 'design', reason: '需先出设计卡' });
  assert.equal(auto.mode, 'auto');
  assert.equal(auto.effective, 'design');
  assert.equal(auto.autoExport, false, 'autoExport defaults to false');
  assert.match(promptPrefixForWorkMode(auto), /智能自动（auto，当前阶段 design）/);
  assert.match(promptPrefixForWorkMode(auto), /未开启自动导出/);

  const autoWithExport = normalizeWorkModeState({ mode: 'produce', autoExport: true });
  assert.equal(autoWithExport.autoExport, true);
  assert.match(promptPrefixForWorkMode(autoWithExport), /已开启「完成后自动导出」/);

  const explicitChat = normalizeWorkModeState({ mode: 'chat', effective: 'produce' });
  assert.equal(explicitChat.effective, 'chat', 'explicit non-auto mode locks its effective phase');
  assert.match(promptPrefixForWorkMode(explicitChat), /快速对话（chat）/);
  assert.match(promptPrefixForWorkMode({ mode: 'design' }), /导演视觉与动效设计卡/);
  assert.match(promptPrefixForWorkMode({ mode: 'produce' }), /制片执行（produce）/);
});

test('dshSessionStore and nativeAgentService persist workMode, emit mode_update, and prepend prompt directive', async t => {
  const root = mkdtempSync(join(tmpdir(), 'openfilm-workmode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storeFile = join(root, 'sessions.json');
  const store = createDshSessionStore({ file: storeFile });

  const prompts = [];
  const ctx = {
    sessionController: {
      async create() { return { sessionId: 'sess-1' }; },
      async *follow() { /* idle stream */ },
      async prompt(arg) {
        prompts.push(arg);
        setTimeout(() => {
          onStatus?.('sess-1', false);
        }, 5);
        return { ok: true };
      },
      async modelCatalog() { return { default: { provider: 'deepseek-official', model: 'deepseek-chat' }, providers: [] }; },
      async projections() { return { values: {} }; },
    },
    on(event, fn) { if (event === 'api-session/status') onStatus = fn; return () => {}; },
  };
  let onStatus;

  const events = [];
  const project = { projectId: 'proj1234', path: root };
  const service = createDshNativeAgentService({
    ctx,
    verifier: async id => (id === project.projectId ? project : null),
    store,
    emit: async (projectId, event) => { events.push({ projectId, event }); return true; },
  });

  try {
    const attached = await service.attach(project.projectId, 'tab-a', { key: 'k-tab-a' });
    assert.equal(attached.workMode.mode, 'auto');
    assert.equal(attached.workMode.effective, 'chat');
    assert.ok(events.some(e => e.event.update?.sessionUpdate === 'mode_update' && e.event.key === 'k-tab-a'));

    const updated = service.setWorkMode(project.projectId, 'tab-a', { mode: 'design', reason: '复杂新片' });
    assert.equal(updated.mode, 'design');
    assert.equal(updated.effective, 'design');
    assert.equal(updated.autoExport, false);

    const exportEnabled = service.setWorkMode(project.projectId, 'tab-a', { autoExport: true });
    assert.equal(exportEnabled.mode, 'design');
    assert.equal(exportEnabled.autoExport, true);

    const persistedStore = createDshSessionStore({ file: storeFile });
    assert.equal(persistedStore.getWorkMode(project.projectId, 'tab-a')?.mode, 'design');
    assert.equal(persistedStore.getWorkMode(project.projectId, 'tab-a')?.autoExport, true);

    await service.send(project.projectId, { conversation: 'tab-a', key: 'k-tab-a', turnId: 't1', text: '做个知识大赏' });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].content[0].text, /^\[会话模式：导演设计（design）/);
    assert.ok(prompts[0].content[0].text.endsWith('做个知识大赏'));

    const modeTool = createModeTool({
      isProjectAgent: () => true,
      projectOf: () => ({ projectId: project.projectId, path: root, conversation: 'tab-a' }),
      getMode: (pid, conv) => service.getWorkMode(pid, conv),
      setMode: (pid, conv, next) => service.setWorkMode(pid, conv, next),
    });
    const toolOut = await modeTool.execute({ mode: 'produce', phase: 'produce', reason: '用户已确认分镜' }, { agent: { session: { id: 'sess-1' } } });
    assert.match(toolOut.text, /制片执行/);
    assert.equal(service.getWorkMode(project.projectId, 'tab-a').mode, 'produce');
  } finally {
    await service.close();
  }
});
