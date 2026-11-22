import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreferencesStore } from '../src/host/preferences.mjs';
import { createWorkbenchSearchRouter } from '../src/native/search-routing.mjs';

test('WorkbenchSearchRouter isolates no996_web_search & restricts web_search strictly inside editing agents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-route-'));
  try {
    const preferences = createPreferencesStore({ home: dir });
    const listeners = new Map();
    const registeredTools = [];
    const guards = [];
    const restrictedDenies = [];

    const makeAgent = (id, preset, isProj) => ({
      id,
      _isProj: isProj,
      session: { header: { agentPreset: preset } },
      ctx: {
        get: (name) => name !== 'tools' ? null : ({
          view: () => ({ restrictableNames: new Set(['web_search', 'web_fetch']) }),
          restrict: (opts) => {
            restrictedDenies.push({ id, opts });
            return () => { restrictedDenies.push({ id, disposed: true }); };
          },
          guard: (fn) => {
            guards.push({ id, fn });
            return () => {};
          },
        }),
      },
    });

    const editingAgent = makeAgent('agent-edit', 'openfilm-video-editing', true);
    const generalAgent = makeAgent('agent-chat', 'default', false);
    const liveAgents = [editingAgent, generalAgent];

    const ctx = {
      agents: { list: () => liveAgents },
      on: (ev, fn) => { listeners.set(ev, fn); return () => listeners.delete(ev); },
      tools: {
        register: (tool, opts) => {
          registeredTools.push({ tool, opts });
          return () => {};
        },
      },
      get: (name) => name === 'web' ? { listProviders: () => [{ id: 'dsh-search' }] } : null,
    };

    const queriesSeen = [];
    const router = createWorkbenchSearchRouter({
      ctx,
      preferences,
      workbenchAuth: { status: async () => ({ loggedIn: true, guest: false, dev: false }) },
      searchProvider: {
        search: async (req) => {
          queriesSeen.push(req);
          return { content: 'summary', sources: [{ url: 'https://example.com/a', title: 'A' }] };
        },
      },
      isProjectAgent: (a) => a._isProj === true,
    });

    const unmount = router.mount();
    await new Promise(r => setTimeout(r, 20));
    const entry = registeredTools.find(r => r.tool.name === 'no996_web_search');
    assert.ok(entry);
    // Default source is `dsh` -> no996_web_search not offered, nothing restricted
    assert.equal(entry.opts.when({ agent: editingAgent }), false);
    assert.equal(restrictedDenies.length, 0);

    // Switch to `no996` -> restricts editingAgent ONLY (never generalAgent, never web_fetch)
    await router.setSource('no996');
    assert.equal(entry.opts.when({ agent: editingAgent }), true);
    assert.equal(entry.opts.when({ agent: generalAgent }), false);
    assert.equal(restrictedDenies.length, 1);
    assert.equal(restrictedDenies[0].id, 'agent-edit');
    assert.deepEqual(restrictedDenies[0].opts, { deny: ['web_search'] });

    // Guard blocks web_search on editingAgent, allows web_fetch
    const guard = guards.find(g => g.id === 'agent-edit');
    assert.ok(guard.fn({ tool: { name: 'web_search' } }));
    assert.equal(guard.fn({ tool: { name: 'web_fetch' } }), undefined);

    const res = await entry.tool.execute({ queries: ['ai video'] }, { agent: editingAgent });
    assert.equal(res.sources.length, 1);
    assert.equal(queriesSeen[0].query, 'ai video');

    // Switching back to `dsh` disposes restriction
    await router.setSource('dsh');
    assert.ok(restrictedDenies.some(d => d.id === 'agent-edit' && d.disposed === true));
    assert.equal(entry.opts.when({ agent: editingAgent }), false);
    unmount();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
