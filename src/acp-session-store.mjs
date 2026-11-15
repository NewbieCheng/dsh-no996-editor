// Where a project's ACP Session ids are remembered between Host restarts.
//
// The ACP agent owns each Session (it is a DSH Session, persisted by DSH itself),
// so this file maps project + conversation -> session id. Losing it is survivable:
// the service falls back to `session/list` by cwd and then to a new Session.
//
// v2 adds per-conversation ids: the panel keeps several conversations per project
// (its session bar), and each one is its own DSH Session. v1 records are read as
// the default conversation, so an upgrade does not strand an open conversation.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 2;
const PROJECT_ID = /^[A-Za-z0-9_-]{6,40}$/;
/** The panel's conversation ids (`s<base36><base36>`); anything else is not resumed. */
const CONVERSATION = /^[A-Za-z0-9_-]{1,64}$/;

function empty() { return { version: VERSION, projects: {} }; }

function migrate(value) {
  if (!value || typeof value.projects !== 'object' || value.projects === null) return empty();
  if (value.version === VERSION) return value;
  if (value.version !== 1) return empty();
  const projects = {};
  for (const [projectId, record] of Object.entries(value.projects)) {
    if (!record || typeof record.sessionId !== 'string' || !record.sessionId) continue;
    projects[projectId] = { sessions: { '': record.sessionId }, ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}) };
  }
  return { version: VERSION, projects };
}

function read(file, fs) {
  try { return migrate(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return empty(); }
}

/**
 * @param {object} [deps]
 * @param {string} [deps.file] - JSON file; without it the store lives in memory (tests)
 * @param {typeof import('node:fs')} [deps.fs]
 */
export function createAcpSessionStore({ file, fs } = {}) {
  const api = fs ?? { readFileSync, writeFileSync, renameSync, mkdirSync };
  let data = file ? read(file, api) : empty();
  const flush = () => {
    if (!file) return;
    try {
      api.mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      api.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
      api.renameSync(temporary, file);
    } catch { /* a lost mapping only costs a new Session, never a broken panel */ }
  };
  const recordOf = projectId => {
    if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return undefined;
    const record = data.projects[projectId];
    return record && typeof record === 'object' && record.sessions && typeof record.sessions === 'object' ? record : undefined;
  };
  const keyOf = conversation => (typeof conversation === 'string' && CONVERSATION.test(conversation) ? conversation : '');
  return {
    /** The default conversation's id (kept for callers that only know a project). */
    get(projectId) {
      const record = recordOf(projectId);
      const sessionId = record?.sessions[''];
      return typeof sessionId === 'string' ? { sessionId, ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}) } : undefined;
    },
    set(projectId, value) {
      if (!recordOf(projectId) && (typeof projectId !== 'string' || !PROJECT_ID.test(projectId))) return;
      if (!value || typeof value.sessionId !== 'string' || !value.sessionId) return;
      const record = data.projects[projectId] ?? (data.projects[projectId] = { sessions: {} });
      record.sessions ??= {};
      record.sessions[''] = value.sessionId;
      if (typeof value.cwd === 'string') record.cwd = value.cwd;
      if (typeof value.model === 'string') record.model = value.model;
      flush();
    },
    /** One conversation's id: what the next turn of that conversation resumes. */
    getSession(projectId, conversation) {
      const record = recordOf(projectId);
      const sessionId = record?.sessions[keyOf(conversation)];
      return typeof sessionId === 'string' ? { sessionId, ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}) } : undefined;
    },
    setSession(projectId, conversation, value) {
      if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return;
      if (!value || typeof value.sessionId !== 'string' || !value.sessionId) return;
      const record = data.projects[projectId] ?? (data.projects[projectId] = { sessions: {} });
      record.sessions ??= {};
      record.sessions[keyOf(conversation)] = value.sessionId;
      if (typeof value.cwd === 'string') record.cwd = value.cwd;
      if (typeof value.model === 'string') record.model = value.model;
      flush();
    },
    remove(projectId) {
      if (data.projects[projectId] === undefined) return;
      delete data.projects[projectId];
      flush();
    },
    removeSession(projectId, conversation) {
      const record = recordOf(projectId);
      if (!record) return;
      delete record.sessions[keyOf(conversation)];
      flush();
    },
    all() {
      return Object.entries(data.projects).flatMap(([projectId, record]) =>
        Object.entries(record.sessions ?? {}).map(([conversation, sessionId]) => ({ projectId, conversation, sessionId })));
    },
  };
}
