import { basename } from 'node:path';

import { buildEditingProjects } from '../../../project/editing-sessions.mjs';
import { readJsonBody } from '../http-body.mjs';

// Editing routes: the sidebar's project list, per-project preferences, archive,
// delete and the recycle-bin flow.
//
// These handlers are read-mostly, but the delete path moves a real folder, so the
// admission checks and the bounded wait for `proxy` are kept exactly as they were
// inside the controller. `getLastProxy` and `getAcpAgentService` are functions
// because both are replaced when Studio restarts; `officialStore` and
// `deleteEditingProject` stay in the controller because they own the Host's
// lifetime and logging.
export function createEditingRoutes({
  ctx,
  register,
  track,
  acpSessions,
  archive,
  archiveBatch,
  editingPrefs,
  verifyOfficialProject,
  resolveDeleteTarget,
  log,
  listTemplates,
  templatesRoot,
  getLastProxy,
  officialStore,
  deleteEditingProject,
  getAcpAgentService,
  onConversationsDeleted,
}) {
  track(register({
    kind: 'exact', path: '/api/no996-openfilm/editing-sessions',
    async handler(req, res) {
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }).end(); return; }
      const admission = ctx.connection.admit({ headers: req.headers });
      if ('rejection' in admission) {
        res.writeHead(admission.rejection).end(admission.rejection === 403 ? 'DSH_ORIGIN_REJECTED' : 'DSH_SESSION_REQUIRED');
        return;
      }
      if (admission.peer.id !== ctx.connection.browserPeer.id) { res.writeHead(403).end('DSH_BROWSER_REQUIRED'); return; }
      try {
        // The proxy is created during Host startup; a sidebar refresh can arrive
        // before it resolves. Waiting forever left the list stuck on "正在读取"
        // (and a restart "fixed" it). Bound the wait, then fall back to the
        // projects this Host already has a bound Session for.
        let proxy;
        try {
          proxy = await Promise.race([
            Promise.resolve(getLastProxy()).catch(() => undefined),
            new Promise(resolve => setTimeout(() => resolve(undefined), 2500)),
          ]);
        } catch { proxy = undefined; }
        const bound = new Map(acpSessions.all().map(record => [record.projectId, record]));
        const prefs = editingPrefs.all();
        const studioProjects = proxy && typeof proxy.listProjects === 'function'
          ? await proxy.listProjects().catch(() => [])
          : [];
        const projects = studioProjects.length
          ? studioProjects
          : [...bound.values()].map(record => ({
            id: record.projectId,
            name: basename(String(record.cwd ?? '')) || record.projectId,
            path: typeof record.cwd === 'string' ? record.cwd : '',
          }));
        // An archived conversation stays listed: it is where the project's
        // history lives, and the panel opens it read-only with a restore
        // action (hiding it made the whole area look empty). Pinned rows lead.
        const items = buildEditingProjects(projects, {
          bound,
          prefs,
          isArchived: sessionId => archive && typeof archive.isArchived === 'function' ? archive.isArchived(sessionId) : false,
        });
        // Each project is a folder whose conversations are the Studio chat's
        // own sessions. The ACP binding is one session; the chat store is the
        // authority on which conversations exist in the panel.
        let store = null;
        try { store = await officialStore(); } catch { store = null; }
        for (const item of items) {
          let sessions = [];
          if (store) {
            try {
              const data = await store.load(item.projectId);
              sessions = (Array.isArray(data?.sessions) ? data.sessions : [])
                .map(session => ({
                  sessionId: String(session?.id ?? ''),
                  title: typeof session?.title === 'string' ? session.title : '',
                  updatedAt: typeof session?.updatedAt === 'string' ? session.updatedAt : '',
                  archived: session?.archived === true,
                }))
                .filter(session => /^[A-Za-z0-9_-]{6,60}$/.test(session.sessionId));
            } catch { /* fall back to the ACP binding */ }
          }
          if (!sessions.length && item.sessionId) {
            sessions = [{ sessionId: item.sessionId, title: '', updatedAt: '', archived: item.archived }];
          }
          for (const session of sessions) {
            const pref = editingPrefs.getSession(item.projectId, session.sessionId);
            session.pinned = pref?.pinned === true;
            const native = acpSessions.getSession?.(item.projectId, session.sessionId);
            if (native?.sessionId && archive.isArchived(native.sessionId)) session.archived = true;
            if (typeof pref?.title === 'string' && pref.title) session.title = pref.title;
          }
          sessions.sort((left, right) => (right.pinned ? 1 : 0) - (left.pinned ? 1 : 0)
            || String(right.updatedAt).localeCompare(String(left.updatedAt)));
          item.sessions = sessions;
        }
        // Only native IDs backed by our persisted bindings, never display names,
        // workspace paths, or OpenFilm's independent conversation IDs.
        const visibleProjects = new Set(items.map(item => item.projectId));
        const hidden = new Set(acpSessions.all()
          .filter(record => visibleProjects.has(record.projectId))
          .map(record => record.sessionId).filter(Boolean));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({
          projects: items,
          hiddenSessionIds: [...hidden],
        }));
      } catch {
        res.writeHead(503).end('EDITING_SESSIONS_UNAVAILABLE');
      }
    },
  }));
  // Pin / display name of one editing row. Cosmetic only: the project, its film
  // and the DSH Session title are untouched.
  track(register({
    kind: 'exact', path: '/api/no996-openfilm/editing-prefs',
    async handler(req, res) {
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
      const admission = ctx.connection.admit({ headers: req.headers });
      if ('rejection' in admission) { res.writeHead(admission.rejection).end(admission.rejection === 403 ? 'DSH_ORIGIN_REJECTED' : 'DSH_SESSION_REQUIRED'); return; }
      if (admission.peer.id !== ctx.connection.browserPeer.id) { res.writeHead(403).end('DSH_BROWSER_REQUIRED'); return; }
      const body = await readJsonBody(req);
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) { res.writeHead(400).end('BAD_PROJECT'); return; }
      try { await verifyOfficialProject(projectId); } catch { res.writeHead(404).end('UNKNOWN_PROJECT'); return; }
      const patch = {};
      if (body.pinned !== undefined) patch.pinned = body.pinned === true;
      if (body.title !== undefined) patch.title = typeof body.title === 'string' ? body.title : '';
      const respondPref = value => {
        const { ok, code, ...pref } = value ?? {};
        const persisted = ok !== false;
        if (!persisted) void log?.warn?.('editing-pref-write-failed', { projectId, code: String(code ?? 'WRITE_FAILED') });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true, persisted, pref }));
      };
      if (typeof body.sessionId === 'string' && /^[A-Za-z0-9_-]{6,60}$/.test(body.sessionId)) {
        respondPref(editingPrefs.setSession(projectId, body.sessionId, patch));
        return;
      }
      respondPref(editingPrefs.set(projectId, patch));
    },
  }));
  if (archiveBatch) track(register({
    kind: 'exact', path: '/api/no996-openfilm/editing-archive-batch',
    async handler(req, res) {
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
      const admission = ctx.connection.admit({ headers: req.headers });
      if ('rejection' in admission) { res.writeHead(admission.rejection).end(); return; }
      if (admission.peer.id !== ctx.connection.browserPeer.id) { res.writeHead(403).end(); return; }
      const body = await readJsonBody(req);
      if (!['preview', 'archive', 'restore'].includes(body.action) || (body.action !== 'preview' && body.confirmed !== true)) {
        res.writeHead(400).end('INVALID_ARCHIVE_ACTION'); return;
      }
      try {
        const result = await archiveBatch(body.action);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(result));
      } catch { res.writeHead(503).end('ARCHIVE_BATCH_FAILED'); }
    },
  }));
  // Archive / restore the project's bound conversation from the editing list.
  track(register({
    kind: 'exact', path: '/api/no996-openfilm/editing-archive',
    async handler(req, res) {
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
      const admission = ctx.connection.admit({ headers: req.headers });
      if ('rejection' in admission) { res.writeHead(admission.rejection).end(admission.rejection === 403 ? 'DSH_ORIGIN_REJECTED' : 'DSH_SESSION_REQUIRED'); return; }
      if (admission.peer.id !== ctx.connection.browserPeer.id) { res.writeHead(403).end('DSH_BROWSER_REQUIRED'); return; }
      const body = await readJsonBody(req);
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) { res.writeHead(400).end('BAD_PROJECT'); return; }
      const archived = body.archived === true;
      let identity;
      try { identity = await resolveDeleteTarget(projectId); }
      catch (error) {
        void log?.warn?.('delete-failed', { what: 'conversation', projectId, code: String(error?.code ?? 'UNKNOWN_PROJECT').slice(0, 40) });
        res.writeHead(404).end('UNKNOWN_PROJECT'); return;
      }
      void log?.info?.('delete-attempt', { what: 'conversation', projectId, source: identity.source, one: typeof body.sessionId === 'string' });
      const record = acpSessions.get(projectId);
      // A conversation row archives that chat session in the Studio store; the
      // project folder row archives the ACP binding (the DSH Session).
      if (typeof body.sessionId === 'string' && /^[A-Za-z0-9_-]{6,60}$/.test(body.sessionId)) {
        try {
          const store = await officialStore();
          const data = await store.load(projectId);
          const items = Array.isArray(data?.sessions) ? data.sessions : [];
          if (!items.some(session => session?.id === body.sessionId)) {
            res.writeHead(404).end('UNKNOWN_CONVERSATION'); return;
          }
          const native = acpSessions.getSession?.(projectId, body.sessionId);
          if (!archived && native?.sessionId && archive.isArchived(native.sessionId)) await archive.unarchive(native.sessionId);
          const sessions = items.map(session => (session?.id === body.sessionId ? { ...session, archived } : session));
          if (Number.isSafeInteger(data?.revision)) await store.saveSessions(projectId, { sessions, last: data.last ?? null, expectedRevision: data.revision });
        } catch { res.writeHead(503).end('ARCHIVE_FAILED'); return; }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true, archived }));
        return;
      }
      if (!record || typeof record.sessionId !== 'string') { res.writeHead(409).end('NO_BINDING'); return; }
      if (!archive.available) { res.writeHead(503).end('ARCHIVE_UNAVAILABLE'); return; }
      try {
        if (archived) await archive.archive(record.sessionId, { stopActivity: true });
        else await archive.unarchive(record.sessionId);
      } catch { res.writeHead(503).end('ARCHIVE_FAILED'); return; }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true, archived }));
    },
  }));
  // Delete the conversation (binding + Studio chat history + archive the DSH
  // Session). The project folder and its film are never touched — deleting a
  // project is a separate Studio action that says so.
  track(register({
    kind: 'exact', path: '/api/no996-openfilm/editing-delete',
    async handler(req, res) {
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
      const admission = ctx.connection.admit({ headers: req.headers });
      if ('rejection' in admission) { res.writeHead(admission.rejection).end(admission.rejection === 403 ? 'DSH_ORIGIN_REJECTED' : 'DSH_SESSION_REQUIRED'); return; }
      if (admission.peer.id !== ctx.connection.browserPeer.id) { res.writeHead(403).end('DSH_BROWSER_REQUIRED'); return; }
      const body = await readJsonBody(req);
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) { res.writeHead(400).end('BAD_PROJECT'); return; }
      try { await verifyOfficialProject(projectId); } catch { res.writeHead(404).end('UNKNOWN_PROJECT'); return; }
      if (Object.hasOwn(body, 'sessionId') && (typeof body.sessionId !== 'string' || !/^[A-Za-z0-9_-]{6,60}$/.test(body.sessionId))) {
        res.writeHead(400).end('BAD_CONVERSATION'); return;
      }
      const one = body.sessionId ?? null;
      let deletion;
      try { deletion = await (await officialStore()).deleteConversations(projectId, one); }
      catch (error) {
        const conflict = error?.code === 'OFFICIAL_CHAT_CONFLICT';
        void log?.warn?.('delete-failed', { what: 'conversation', projectId, code: error?.code ?? 'DELETE_FAILED' });
        res.writeHead(conflict ? 409 : 503).end(conflict ? 'OFFICIAL_CHAT_CONFLICT' : 'DELETE_FAILED');
        return;
      }
      const { removed, remaining, revision } = deletion;
      const service = getAcpAgentService();
      const providerKey = removed[0]?.agentSessions?.deepseek;
      const keys = new Set(one === null ? [] : [one, ...(typeof providerKey === 'string' && providerKey ? [providerKey] : [])]);
      const legacy = one !== null && acpSessions.get?.(projectId)?.sessionId === one ? acpSessions.get(projectId) : null;
      if (legacy) keys.add(legacy.conversation ?? '');
      const nativeIds = new Set(one === null
        ? acpSessions.all().filter(row => row.projectId === projectId).map(row => row.sessionId)
        : [...keys].map(key => acpSessions.getSession?.(projectId, key)?.sessionId).filter(Boolean));
      if (legacy) nativeIds.add(legacy.sessionId);
      if (one === null) acpSessions.remove(projectId);
      else for (const key of keys) acpSessions.removeSession?.(projectId, key);

      const receipt = { projectId, sessionId: one, revision, remaining };
      try { onConversationsDeleted?.({ ...receipt, removedIds: removed.map(item => item.id) }); }
      catch { /* the committed deletion remains available through chat:load */ }
      let cleanupPending = false;
      for (const sid of nativeIds) {
        try {
          if (!archive.available) cleanupPending = true;
          else if (!archive.isArchived(sid)) await archive.archive(sid, { stopActivity: true });
        } catch { cleanupPending = true; }
      }
      // Do not reset other conversations on the same film, even if native archival failed.
      if (one === null) await service?.reset?.(projectId);
      else for (const key of keys) await service?.resetConversation?.(projectId, key);
      if (cleanupPending) void log?.warn?.('conversation-native-cleanup-failed', { projectId });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true, ...receipt, cleanupPending }));
    },
  }));
  // Delete the project itself: its OpenFilm folder (default: a recoverable trash
  // beside the projects root), every Studio conversation it has, the ACP binding,
  // pins/titles, and archive the bound DSH Sessions. The folder move is the
  // irreversible step, so it runs first and aborts the whole request on failure:
  // chat records are never dropped for a project that stayed on disk.
  track(register({
    kind: 'exact', path: '/api/no996-openfilm/editing-delete-project',
    async handler(req, res) {
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
      const admission = ctx.connection.admit({ headers: req.headers });
      if ('rejection' in admission) { res.writeHead(admission.rejection).end(admission.rejection === 403 ? 'DSH_ORIGIN_REJECTED' : 'DSH_SESSION_REQUIRED'); return; }
      if (admission.peer.id !== ctx.connection.browserPeer.id) { res.writeHead(403).end('DSH_BROWSER_REQUIRED'); return; }
      const body = await readJsonBody(req);
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(projectId)) { res.writeHead(400).end('BAD_PROJECT'); return; }
      const permanent = body.permanent === true;
      let result;
      try { result = await deleteEditingProject(projectId, { permanent }); }
      catch (error) {
        const code = String(error?.code ?? '');
        void log?.warn?.('delete-failed', { what: 'project', projectId, code: code.slice(0, 40) });
        if (code === 'UNKNOWN_PROJECT') { res.writeHead(404).end('UNKNOWN_PROJECT'); return; }
        if (code === 'PROJECT_BUSY') { res.writeHead(409).end('PROJECT_BUSY'); return; }
        if (code === 'PROJECT_NOT_OPENFILM' || code === 'PROJECT_PATH_INVALID') { res.writeHead(422).end(code); return; }
        res.writeHead(500).end('DELETE_FAILED');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify({ ok: true, ...result }));
    },
  }));

  return { disposers: [] };
}
