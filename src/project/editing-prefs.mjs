// Per-project display preferences for the sidebar's editing area: a pin and a
// display title. They are deliberately NOT the project's real name or the DSH
// Session title: renaming here only changes how this list labels the row, and a
// pin only changes its order, so nothing a person sees in Studio or DSH moves.
//
// The file is small and rewritten atomically; a lost file costs the pins and
// display names, never a project or a conversation.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 1;
const PROJECT_ID = /^[A-Za-z0-9_-]{6,40}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{6,60}$/;
const MAX_TITLE = 120;

function empty() { return { version: VERSION, projects: {} }; }

function read(file, fs) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.version !== VERSION || typeof value.projects !== 'object' || value.projects === null) return empty();
    return value;
  } catch { return empty(); }
}

/**
 * @param {object} [deps]
 * @param {string} [deps.file] - JSON file; without it the store lives in memory (tests)
 * @param {typeof import('node:fs')} [deps.fs]
 */
export function createEditingPrefs({ file, fs } = {}) {
  const api = fs ?? { readFileSync, writeFileSync, renameSync, mkdirSync };
  let data = file ? read(file, api) : empty();
  let lastWrite = { ok: true };
  const flush = () => {
    if (!file) return lastWrite = { ok: true };
    try {
      api.mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      api.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
      api.renameSync(temporary, file);
      return lastWrite = { ok: true };
    } catch (error) {
      // Pins and display names are cosmetic, so memory keeps the change and the
      // list stays usable; the caller is still told it will not survive a restart.
      const code = typeof error?.code === 'string' && /^[A-Z_]{2,16}$/.test(error.code) ? error.code : 'WRITE_FAILED';
      return lastWrite = { ok: false, code };
    }
  };
  /** Whether the latest change reached the file, with a fixed code when it did not. */
  const writeState = () => lastWrite;
  return {
    get(projectId) {
      if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return undefined;
      const record = data.projects[projectId];
      if (!record || typeof record !== 'object') return undefined;
      return {
        pinned: record.pinned === true,
        ...(typeof record.title === 'string' && record.title ? { title: record.title } : {}),
      };
    },
    set(projectId, patch) {
      if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return undefined;
      if (!patch || typeof patch !== 'object') return undefined;
      const next = { ...(data.projects[projectId] ?? {}) };
      if (patch.pinned !== undefined) {
        if (patch.pinned) next.pinned = true; else delete next.pinned;
      }
      if (patch.title !== undefined) {
        const title = typeof patch.title === 'string' ? patch.title.trim().slice(0, MAX_TITLE) : '';
        if (title) next.title = title; else delete next.title;
      }
      if (Object.keys(next).length === 0) delete data.projects[projectId];
      else data.projects[projectId] = next;
      const write = flush();
      return { ...(this.get(projectId) ?? { pinned: false }), ...write };
    },
    /** Forget a project's pin/title and every conversation preference under it. */
    remove(projectId) {
      if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return false;
      let changed = false;
      if (data.projects[projectId]) { delete data.projects[projectId]; changed = true; }
      for (const key of Object.keys(data.sessions ?? {})) {
        if (!key.startsWith(`${projectId}:`)) continue;
        delete data.sessions[key];
        changed = true;
      }
      if (changed) flush();
      return changed;
    },
    writeState,
    all() {
      return Object.fromEntries(Object.entries(data.projects).map(([projectId, record]) => [projectId, {
        pinned: record?.pinned === true,
        ...(typeof record?.title === 'string' && record.title ? { title: record.title } : {}),
      }]));
    },
    getSession(projectId, sessionId) {
      if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return undefined;
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined;
      const record = data.sessions?.[`${projectId}:${sessionId}`];
      if (!record || typeof record !== 'object') return undefined;
      return {
        pinned: record.pinned === true,
        ...(typeof record.title === 'string' && record.title ? { title: record.title } : {}),
      };
    },
    setSession(projectId, sessionId, patch) {
      if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return undefined;
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined;
      if (!patch || typeof patch !== 'object') return undefined;
      data.sessions ??= {};
      const key = `${projectId}:${sessionId}`;
      const next = { ...(data.sessions[key] ?? {}) };
      if (patch.pinned !== undefined) {
        if (patch.pinned) next.pinned = true; else delete next.pinned;
      }
      if (patch.title !== undefined) {
        const title = typeof patch.title === 'string' ? patch.title.trim().slice(0, MAX_TITLE) : '';
        if (title) next.title = title; else delete next.title;
      }
      if (Object.keys(next).length === 0) delete data.sessions[key];
      else data.sessions[key] = next;
      const write = flush();
      return { ...(this.getSession(projectId, sessionId) ?? { pinned: false }), ...write };
    },
  };
}
