// Deleting a conversation in the panel is only real if the Host forgets its turns too.
//
// The chat removes the session from the list it saves; this store must drop every
// turn that belonged to a session the saved list no longer names — otherwise a
// deleted conversation keeps its bytes on disk forever and a later read hands them
// back to a list that no longer contains it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOfficialChatStore } from '../src/official/official-chat-store.mjs';

const chain = () => ({ min: chain, max: chain, regex: chain, strict: chain, optional: () => chain });
const z = { object: chain, string: chain, array: chain, literal: chain, unknown: chain };

const projectPath = 'C:\\Films\\demo';
const turn = (id, sessionId) => ({ turn: { id, sessionId, createdAt: '2026-01-01T00:00:00.000Z', status: 'done' }, items: [] });

function stored() {
  return {
    version: 1,
    revision: 3,
    sessions: [{ id: 's1' }, { id: 's2' }],
    last: 's2',
    turns: [turn('t1', 's1'), turn('t2', 's2')],
  };
}

async function open({ failWrite = false, oldPath = projectPath } = {}) {
  let currentPath = oldPath;
  let writes = 0;
  let record = { projectId: 'proj123', path: oldPath, data: JSON.stringify(stored()) };
  const ctx = {
    storageDomain: {
      async open() {
        return {
          table: () => ({
            get: () => record,
            put: async (key, value) => {
              if (failWrite) throw new Error('disk full');
              writes += 1;
              record = value;
            },
            delete: async () => { record = undefined; },
          }),
          close: async () => {},
        };
      },
    },
  };
  const store = await openOfficialChatStore(ctx, { z, requireVerifiedProject: async projectId => ({ projectId, path: currentPath }) });
  return { store, record: () => record, writes: () => writes, setCurrentPath: path => { currentPath = path; } };
}

test('removing a project drops its chat record without re-verifying a deleted folder', async () => {
  const { store, record } = await open();
  await store.remove('proj123');
  assert.equal(record(), undefined);
  // Idempotent: the second call is a no-op, not an error.
  await store.remove('proj123');
  const loaded = await store.load('proj123');
  assert.deepEqual(loaded.sessions, []);
});

test('saving a list without a conversation drops that conversation\'s turns', async () => {
  const { store, record } = await open();
  const revision = await store.saveSessions('proj123', {
    sessions: [{ id: 's2' }], last: 's2', expectedRevision: 3,
  });
  assert.equal(revision, 4);
  const loaded = await store.load('proj123');
  assert.deepEqual(loaded.sessions.map(s => s.id), ['s2']);
  assert.deepEqual(loaded.turns.map(e => e.turn.id), ['t2'], 'a deleted conversation keeps no turn behind');
  const persisted = JSON.parse(record().data);
  assert.deepEqual(persisted.turns.map(e => e.turn.id), ['t2'], 'and the record on disk was rewritten');
});

test('sidebar deletion is serialized with a save and refuses a stale list afterward', async () => {
  const { store } = await open();
  const write = store.saveTurn('proj123', { ...turn('t3', 's1'), expectedRevision: 3 });
  const deletion = store.deleteConversations('proj123', 's2');
  assert.equal(await write, 4);
  assert.deepEqual(await deletion, { removed: [{ id: 's2' }], remaining: 1, revision: 5 });
  await assert.rejects(store.saveSessions('proj123', {
    sessions: [{ id: 's1' }, { id: 's2' }], last: 's2', expectedRevision: 4,
  }), { code: 'OFFICIAL_CHAT_CONFLICT' });
  const loaded = await store.load('proj123');
  assert.equal(loaded.last, 's1');
  assert.deepEqual(loaded.turns.map(entry => entry.turn.id), ['t1', 't3']);
  assert.deepEqual(await store.deleteConversations('proj123', 's2'), { removed: [], remaining: 1, revision: 5 });
});

test('a saved web search retains its query, outcome and result on load', async () => {
  const { store } = await open();
  const items = [{ id: 'act:search-1', kind: 'act', act: 'research.search', tool: 'web_search',
    query: '今日资讯', pending: false, toolOutcome: 'completed', toolOutput: '示例结果 https://example.com/news' }];
  await store.saveTurn('proj123', { ...turn('t3', 's1'), items, expectedRevision: 3 });
  const loaded = await store.load('proj123');
  assert.deepEqual(loaded.turns.find(entry => entry.turn.id === 't3')?.items, items);
});

async function projectFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'openfilm-chat-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = join(root, 'Original');
  const after = join(root, 'Renamed');
  const make = async (path, id = 'proj123') => {
    await mkdir(join(path, '.film'), { recursive: true });
    await writeFile(join(path, '.film', 'id'), `${id}\n`);
  };
  await make(before);
  return { ...await open({ oldPath: before }), before, after, make };
}

for (const first of ['turn', 'sessions', 'load']) {
  test(`a verified folder rename permits ${first} before any other chat operation`, async t => {
    const { store, record, writes, setCurrentPath, before, after } = await projectFixture(t);
    await rename(before, after);
    setCurrentPath(after);
    if (first === 'turn') {
      assert.equal(await store.saveTurn('proj123', { ...turn('t3', 's1'), expectedRevision: 3 }), 4);
    } else if (first === 'sessions') {
      assert.equal(await store.saveSessions('proj123', {
        sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }], last: 's3', expectedRevision: 3,
      }), 4);
    } else {
      assert.equal((await store.load('proj123')).revision, 3);
    }
    assert.equal(record().path, after);
    assert.equal(writes(), 1, 'path and data must be committed together');
    const data = await store.load('proj123');
    assert.deepEqual(data.turns.map(t => t.turn.id), first === 'turn' ? ['t1', 't2', 't3'] : ['t1', 't2']);
    assert.deepEqual(data.sessions.map(s => s.id), first === 'sessions' ? ['s1', 's2', 's3'] : ['s1', 's2']);
    assert.equal(writes(), 1, 'reopening must not rewrite an already rebound record');
  });
}

test('routing lookup returns only session rows without rebinding a renamed folder on disk', async t => {
  const { store, record, writes, setCurrentPath, before, after } = await projectFixture(t);
  await rename(before, after);
  setCurrentPath(after);
  assert.deepEqual(await store.listSessions('proj123'), { sessions: [{ id: 's1' }, { id: 's2' }] });
  assert.equal(record().path, before);
  assert.equal(writes(), 0);
});

test('a copied ID while the old directory exists cannot claim the chat', async t => {
  const { store, record, writes, setCurrentPath, before, after, make } = await projectFixture(t);
  await make(after);
  setCurrentPath(after);
  await assert.rejects(store.load('proj123'), { code: 'OFFICIAL_CHAT_PATH_CHANGED' });
  await assert.rejects(store.saveTurn('proj123', { ...turn('t3', 's1'), expectedRevision: 3 }), { code: 'OFFICIAL_CHAT_PATH_CHANGED' });
  assert.equal(record().path, before);
  assert.equal(writes(), 0);
});

test('a mismatched project marker blocks a write even if the old directory is gone', async t => {
  const { store, record, writes, setCurrentPath, before, after } = await projectFixture(t);
  await rename(before, after);
  await writeFile(join(after, '.film', 'id'), 'another-project\n');
  setCurrentPath(after);
  await assert.rejects(store.saveSessions('proj123', { sessions: [], last: null, expectedRevision: 3 }), { code: 'OFFICIAL_CHAT_PATH_CHANGED' });
  assert.equal(record().path, before);
  assert.equal(writes(), 0);
});

test('a rename does not allow a stale writer to change data or even rebind the path', async t => {
  const { store, record, writes, setCurrentPath, before, after } = await projectFixture(t);
  await rename(before, after);
  setCurrentPath(after);
  await assert.rejects(store.saveTurn('proj123', { ...turn('t3', 's1'), expectedRevision: 2 }), { code: 'OFFICIAL_CHAT_CONFLICT' });
  assert.equal(record().path, before);
  assert.equal(writes(), 0);
});
