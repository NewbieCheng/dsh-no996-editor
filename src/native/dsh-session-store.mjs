// Where a project's native DSH Session ids are remembered between Host restarts.
//
// Each conversation in the panel maps to a real DSH Session persisted by
// `sessionController` in `$DSH_HOME/sessions/`. Losing this file only costs
// opening a fresh Session on the next turn.
import { readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION = 2;
const PROJECT_ID = /^[A-Za-z0-9_-]{6,40}$/;
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
 * Persist project/conversation -> DSH sessionId mappings.
 * @param {object} [deps]
 * @param {string} [deps.file] - JSON file; without it the store lives in memory (tests)
 * @param {typeof import('node:fs')} [deps.fs]
 */
export function createDshSessionStore({ file, fs } = {}) {
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
  const selectionOf = (record, key) => {
    const raw = record?.selections?.[key];
    if (raw && typeof raw.provider === 'string' && raw.provider && typeof raw.model === 'string' && raw.model) {
      return {
        provider: raw.provider,
        model: raw.model,
        ...(typeof raw.reasoningEffort === 'string' && raw.reasoningEffort ? { reasoningEffort: raw.reasoningEffort } : {}),
      };
    }
    // Legacy project-level "provider/model" string from older builds.
    if (key === '' && typeof record?.model === 'string' && record.model.includes('/')) {
      const slash = record.model.indexOf('/');
      const provider = record.model.slice(0, slash);
      const model = record.model.slice(slash + 1);
      if (provider && model) return { provider, model };
    }
    return undefined;
  };
  const writeSelection = (record, key, selection) => {
    if (!selection || typeof selection.provider !== 'string' || !selection.provider ||
        typeof selection.model !== 'string' || !selection.model) return;
    record.selections ??= {};
    record.selections[key] = {
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
    };
  };
  return {
    get(projectId) {
      const record = recordOf(projectId);
      const sessionId = record?.sessions[''];
      if (typeof sessionId !== 'string') return undefined;
      const selection = selectionOf(record, '');
      return {
        sessionId,
        ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
        ...(selection ? { selection } : {}),
      };
    },
    set(projectId, value) {
      if (!recordOf(projectId) && (typeof projectId !== 'string' || !PROJECT_ID.test(projectId))) return;
      if (!value || typeof value.sessionId !== 'string' || !value.sessionId) return;
      const record = data.projects[projectId] ?? (data.projects[projectId] = { sessions: {} });
      record.sessions ??= {};
      record.sessions[''] = value.sessionId;
      if (typeof value.cwd === 'string') record.cwd = value.cwd;
      if (value.selection) writeSelection(record, '', value.selection);
      else if (typeof value.model === 'string') record.model = value.model;
      flush();
    },
    getSession(projectId, conversation) {
      const record = recordOf(projectId);
      const key = keyOf(conversation);
      const sessionId = record?.sessions[key];
      if (typeof sessionId !== 'string') return undefined;
      const selection = selectionOf(record, key);
      return {
        sessionId,
        ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
        ...(selection ? { selection } : {}),
      };
    },
    setSession(projectId, conversation, value) {
      if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return;
      if (!value || typeof value.sessionId !== 'string' || !value.sessionId) return;
      const record = data.projects[projectId] ?? (data.projects[projectId] = { sessions: {} });
      const key = keyOf(conversation);
      record.sessions ??= {};
      record.sessions[key] = value.sessionId;
      if (typeof value.cwd === 'string') record.cwd = value.cwd;
      if (value.selection) writeSelection(record, key, value.selection);
      else if (typeof value.model === 'string') record.model = value.model;
      flush();
    },
    /** Update only the remembered model/effort for a conversation (sessionId unchanged). */
    setSelection(projectId, conversation, selection) {
      if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) return;
      const record = recordOf(projectId);
      if (!record) return;
      writeSelection(record, keyOf(conversation), selection);
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
      const key = keyOf(conversation);
      if (record.sessions[key] === undefined) return;
      delete record.sessions[key];
      if (Object.keys(record.sessions).length === 0) delete data.projects[projectId];
      flush();
    },
    all() {
      return Object.entries(data.projects).flatMap(([projectId, record]) =>
        Object.entries(record.sessions ?? {}).map(([conversation, sessionId]) => ({ projectId, conversation, sessionId })));
    },
  };
}
