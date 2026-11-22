import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const OFFICIAL_CHAT_DOMAIN = 'no996_openfilm_official_chat';
// Maximum UTF-8 bytes for one project's complete chat record, including turns.
export const OFFICIAL_CHAT_MAX_BYTES = 8 * 1024 * 1024;

const PROJECT_ID = /^[A-Za-z0-9_-]{6,40}$/;
const TURN_ID = /^[\w:-]{1,120}$/;
const failure = (code, message, cause) => Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
const keyOf = id => createHash('sha256').update(id, 'utf8').digest('hex');

// Studio preserves .film/id across a rename. A second, still-existing directory
// with the old path must not inherit or lose chat just because an ID was copied.
//
// Returns why, not only whether: "it was renamed" and "another folder copied the
// id" need different answers, and a bare false made the 503 unreadable. The reason
// names the failed check and never a path.
const PATH_CHANGE_REASONS = new Set([
  'no-previous-path',
  'no-metadata',
  'no-marker',
  'marker-mismatch',
  'current-unreadable',
  'old-path-still-present',
  'not-same-directory',
]);
async function sameRenamedProject(projectId, previousPath, path) {
  if (typeof previousPath !== 'string' || !isAbsolute(previousPath)) return { same: false, reason: 'no-previous-path' };
  try {
    const metadata = join(path, '.film');
    if (!(await lstat(metadata)).isDirectory()) return { same: false, reason: 'no-metadata' };
    const markerPath = join(metadata, 'id');
    const marker = await lstat(markerPath);
    if (!marker.isFile() || marker.size > 128) return { same: false, reason: 'no-marker' };
    if ((await readFile(markerPath, 'utf8')).trim() !== projectId) return { same: false, reason: 'marker-mismatch' };
    const current = await stat(path, { bigint: true });
    if (!current.isDirectory()) return { same: false, reason: 'current-unreadable' };
    try {
      const previous = await stat(previousPath, { bigint: true });
      if (!previous.isDirectory()) return { same: false, reason: 'not-same-directory' };
      // Same physical directory: an inode match where the filesystem reports one,
      // otherwise the resolved path. Windows can report ino 0, and a path spelling
      // difference (8.3 short name, drive case) is still the same folder.
      if (current.ino !== 0n && previous.ino === current.ino && previous.dev === current.dev) return { same: true, reason: 'same-inode' };
      const [a, b] = await Promise.all([realpath(path), realpath(previousPath)]);
      return a === b ? { same: true, reason: 'same-realpath' } : { same: false, reason: 'not-same-directory' };
    } catch (error) {
      // The old directory is gone: that is exactly what a rename looks like.
      if (error?.code === 'ENOENT') return { same: true, reason: 'old-path-gone' };
      return { same: false, reason: 'not-same-directory' };
    }
  } catch {
    return { same: false, reason: 'current-unreadable' };
  }
}

/**
 * Host-only storage. requireVerifiedProject(projectId) must resolve to a Host
 * verified { projectId, path } with a canonical absolute Host path; it must
 * reject absent, revoked or unverified projects.
 * The future Host route owns authentication and this authority; never implement
 * it by trusting a renderer-provided path. No project path is accepted here.
 *
 * One instance owns this domain in a Host. Serialization is per project within
 * this instance, not a cross-process transaction. Existing OpenFilm project
 * files and the DSH project/session mapping are neither read nor migrated.
 */
export async function openOfficialChatStore(ctx, { z, requireVerifiedProject } = {}) {
  if (typeof ctx?.storageDomain?.open !== 'function' || !z?.object || typeof requireVerifiedProject !== 'function') {
    throw failure('OFFICIAL_CHAT_DEPENDENCY', 'storageDomain, Zod and Host project verification are required');
  }
  const domain = await ctx.storageDomain.open({
    name: OFFICIAL_CHAT_DOMAIN,
    version: 1,
    layout: 'per-record',
    tables: { projects: { valueSchema: z.object({ projectId: z.string().regex(PROJECT_ID), path: z.string().min(1), data: z.string().max(OFFICIAL_CHAT_MAX_BYTES) }).strict() } },
  });
  const table = domain.table('projects');
  const inFlight = new Map();
  const uncertain = new Set();
  let closing = false;
  let closePromise;

  function decode(record, projectId) {
    if (!record) return { version: 1, revision: 0, sessions: [], last: null, turns: [] };
    if (record.projectId !== projectId) throw failure('OFFICIAL_CHAT_COLLISION', 'Stored project identity does not match');
    if (typeof record.data !== 'string' || Buffer.byteLength(record.data, 'utf8') > OFFICIAL_CHAT_MAX_BYTES) {
      throw failure('OFFICIAL_CHAT_INVALID', 'Stored chat is invalid or exceeds the size limit');
    }
    let data;
    try { data = JSON.parse(record.data); } catch (cause) { throw failure('OFFICIAL_CHAT_INVALID', 'Stored chat is not valid JSON', cause); }
    if (!data || data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.sessions) ||
        !data.sessions.every(s => s && typeof s.id === 'string') ||
        !(data.last === null || typeof data.last === 'string') || !Array.isArray(data.turns) ||
        !data.turns.every(e => e && e.turn && typeof e.turn.id === 'string' && TURN_ID.test(e.turn.id) && Array.isArray(e.items)) ||
        new Set(data.turns.map(e => e.turn.id)).size !== data.turns.length) {
      throw failure('OFFICIAL_CHAT_INVALID', 'Stored chat has an invalid shape');
    }
    return data;
  }

  // Snapshot as official JSON persistence does; a caller cannot mutate a queued write.
  function snapshot(value) {
    let text;
    try { text = JSON.stringify(value); } catch (cause) { throw failure('OFFICIAL_CHAT_INPUT', 'Chat data must be JSON serializable', cause); }
    if (typeof text !== 'string') throw failure('OFFICIAL_CHAT_INPUT', 'Chat data must be JSON serializable');
    if (Buffer.byteLength(text, 'utf8') > OFFICIAL_CHAT_MAX_BYTES) throw failure('OFFICIAL_CHAT_SIZE', 'Project chat exceeds the size limit');
    return JSON.parse(text);
  }

  function run(projectId, operation) {
    if (closing) return Promise.reject(failure('OFFICIAL_CHAT_CLOSED', 'Chat store is closing or closed'));
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return Promise.reject(failure('OFFICIAL_CHAT_INPUT', 'A valid project ID is required'));
    const key = keyOf(projectId);
    const previous = inFlight.get(key);
    const pending = (previous ? previous.catch(() => {}) : Promise.resolve()).then(async () => {
      const identity = await requireVerifiedProject(projectId);
      if (!identity || identity.projectId !== projectId || typeof identity.path !== 'string' || !isAbsolute(identity.path)) throw failure('OFFICIAL_CHAT_UNVERIFIED', 'Host project verification failed');
      if (uncertain.has(key)) throw failure('OFFICIAL_CHAT_RECOVERY_REQUIRED', 'A prior write has an uncertain outcome; reopen and recover before writing or reading');
      return operation(key, identity.path);
    });
    inFlight.set(key, pending);
    return pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); });
  }

  async function put(key, projectId, path, data) {
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text, 'utf8') > OFFICIAL_CHAT_MAX_BYTES) throw failure('OFFICIAL_CHAT_SIZE', 'Project chat exceeds the size limit');
    try { await table.put(key, { projectId, path, data: text }); }
    catch (cause) {
      // A failed write may have reached the medium; do not pretend it failed cleanly.
      uncertain.add(key);
      throw failure('OFFICIAL_CHAT_RECOVERY_REQUIRED', 'Chat write outcome is uncertain; reopen and recover', cause);
    }
  }

  async function readRecord(key, projectId, path) {
    const record = table.get(key);
    const data = decode(record, projectId);
    const rebound = !!record && record.path !== path;
    if (rebound) {
      const identity = await sameRenamedProject(projectId, record.path, path);
      if (!identity.same) {
        // The stored chat is never overwritten on a guess: a different folder that
        // copied the id would otherwise inherit (and then lose) someone's history.
        throw Object.assign(
          failure('OFFICIAL_CHAT_PATH_CHANGED', 'The project directory changed; chat recovery is required'),
          { diag: { reason: PATH_CHANGE_REASONS.has(identity.reason) ? identity.reason : 'not-same-directory' } },
        );
      }
    }
    return { data, rebound };
  }

  function load(projectId) {
    return run(projectId, async (key, path) => {
      const { data, rebound } = await readRecord(key, projectId, path);
      if (rebound) await put(key, projectId, path, data);
      // A completed read proves the record is intact; do not keep a project locked
      // out of every later write because one earlier write reported uncertainty.
      uncertain.delete(key);
      const turns = [...data.turns].sort((a, b) => String(a.turn.createdAt).localeCompare(String(b.turn.createdAt)));
      return { sessions: data.sessions, last: data.last, turns, revision: data.revision };
    });
  }

  /**
   * Drop a project's complete chat record. Called only when the project folder
   * itself is being deleted, so the usual folder verification would fail; the
   * key is enough, and the table's delete is idempotent.
   */
  function remove(projectId) {
    if (closing) return Promise.reject(failure('OFFICIAL_CHAT_CLOSED', 'Chat store is closing or closed'));
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return Promise.reject(failure('OFFICIAL_CHAT_INPUT', 'A valid project ID is required'));
    const key = keyOf(projectId);
    const previous = inFlight.get(key);
    const pending = (previous ? previous.catch(() => {}) : Promise.resolve()).then(() => table.delete(key));
    inFlight.set(key, pending);
    return pending.finally(() => { if (inFlight.get(key) === pending) inFlight.delete(key); });
  }

  function saveSessions(projectId, { sessions, last, expectedRevision } = {}) {
    let copy;
    try { copy = snapshot({ sessions, last, expectedRevision }); } catch (error) { return Promise.reject(error); }
    if (!Array.isArray(copy.sessions) || !copy.sessions.every(s => s && typeof s.id === 'string') ||
        !(copy.last === null || typeof copy.last === 'string') || !Number.isSafeInteger(copy.expectedRevision) || copy.expectedRevision < 0) {
      return Promise.reject(failure('OFFICIAL_CHAT_INPUT', 'Sessions and last have an invalid shape'));
    }
    return run(projectId, async (key, path) => {
      // The same put commits both the new path and the revision-checked mutation.
      const { data } = await readRecord(key, projectId, path);
      if (data.revision !== copy.expectedRevision || data.revision === Number.MAX_SAFE_INTEGER) throw failure('OFFICIAL_CHAT_CONFLICT', 'Chat changed in another view; reload before saving');
      data.sessions = copy.sessions;
      data.last = copy.last;
      // Deleting a conversation deletes its messages too: any stored turn that
      // names a session no longer in the list is dropped, not just hidden.
      const kept = new Set(copy.sessions.map(s => s.id));
      if (data.turns.some(t => typeof t?.turn?.sessionId === 'string' && !kept.has(t.turn.sessionId))) {
        data.turns = data.turns.filter(t => typeof t?.turn?.sessionId !== 'string' || kept.has(t.turn.sessionId));
      }
      data.revision += 1;
      await put(key, projectId, path, data);
      return data.revision;
    });
  }

  // Sidebar deletion reads and writes inside one project queue slot. A stale
  // client must not win over a concurrent save by replaying an older full list.
  function deleteConversations(projectId, sessionId = null) {
    if (sessionId !== null && (typeof sessionId !== 'string' || !sessionId)) {
      return Promise.reject(failure('OFFICIAL_CHAT_INPUT', 'A valid conversation ID is required'));
    }
    return run(projectId, async (key, path) => {
      const { data, rebound } = await readRecord(key, projectId, path);
      const removed = data.sessions.filter(item => sessionId === null || item.id === sessionId);
      const remaining = data.sessions.filter(item => sessionId !== null && item.id !== sessionId);
      const turns = sessionId === null ? [] : data.turns.filter(entry => entry.turn.sessionId !== sessionId);
      if (sessionId !== null && !removed.length && turns.length === data.turns.length) {
        if (rebound) await put(key, projectId, path, data);
        return { removed, remaining: data.sessions.length, revision: data.revision };
      }
      if (data.revision === Number.MAX_SAFE_INTEGER) throw failure('OFFICIAL_CHAT_CONFLICT', 'Chat revision exhausted');
      data.sessions = remaining;
      data.turns = turns;
      if (!remaining.some(item => item.id === data.last)) data.last = remaining[0]?.id ?? null;
      data.revision += 1;
      await put(key, projectId, path, data);
      return { removed, remaining: remaining.length, revision: data.revision };
    });
  }

  function saveTurn(projectId, entry) {
    let copy;
    try { copy = snapshot(entry); } catch (error) { return Promise.reject(error); }
    if (!copy?.turn || typeof copy.turn.id !== 'string' || !TURN_ID.test(copy.turn.id) || !Array.isArray(copy.items) || !Number.isSafeInteger(copy.expectedRevision) || copy.expectedRevision < 0) {
      return Promise.reject(failure('OFFICIAL_CHAT_INPUT', 'Not a turn'));
    }
    // Official saveTurn persists only turn and items.
    copy = { turn: copy.turn, items: copy.items, expectedRevision: copy.expectedRevision };
    return run(projectId, async (key, path) => {
      // The same put commits both the new path and the revision-checked mutation.
      const { data } = await readRecord(key, projectId, path);
      if (data.revision !== copy.expectedRevision || data.revision === Number.MAX_SAFE_INTEGER) throw failure('OFFICIAL_CHAT_CONFLICT', 'Chat changed in another view; reload before saving');
      const entry = { turn: copy.turn, items: copy.items };
      const index = data.turns.findIndex(item => item.turn.id === copy.turn.id);
      if (index < 0) data.turns.push(entry); else data.turns[index] = entry;
      data.revision += 1;
      await put(key, projectId, path, data);
      return data.revision;
    });
  }

  function close() {
    if (!closePromise) {
      closing = true;
      closePromise = Promise.allSettled([...inFlight.values()]).then(() => domain.close());
    }
    return closePromise;
  }
  return Object.freeze({ load, saveSessions, saveTurn, deleteConversations, remove, close });
}
