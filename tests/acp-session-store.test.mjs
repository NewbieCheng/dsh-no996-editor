// The ACP Session store: one id per project *and conversation*, and an upgrade path
// for the file written before conversations existed.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAcpSessionStore } from '../src/acp-session-store.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'no996-acp-store-'));
const PROJECT = 'proj123456';

test('each conversation keeps its own session id', () => {
  const store = createAcpSessionStore();
  store.setSession(PROJECT, 'sa', { sessionId: 'session-a', cwd: 'C:\\films\\one' });
  store.setSession(PROJECT, 'sb', { sessionId: 'session-b' });
  assert.equal(store.getSession(PROJECT, 'sa').sessionId, 'session-a');
  assert.equal(store.getSession(PROJECT, 'sb').sessionId, 'session-b');
  assert.equal(store.getSession(PROJECT, 'sc'), undefined);
  // The default conversation is the project's own record, which is what the older
  // callers (delete, archive) still read.
  store.set(PROJECT, { sessionId: 'session-default' });
  assert.equal(store.get(PROJECT).sessionId, 'session-default');
  assert.equal(store.getSession(PROJECT, '').sessionId, 'session-default');
  store.removeSession(PROJECT, 'sa');
  assert.equal(store.getSession(PROJECT, 'sa'), undefined);
  assert.equal(store.getSession(PROJECT, 'sb').sessionId, 'session-b');
});

test('a v1 file is read as the default conversation', () => {
  const dir = scratch();
  const file = join(dir, 'acp-sessions.json');
  writeFileSync(file, JSON.stringify({ version: 1, projects: { [PROJECT]: { sessionId: 'session-old', cwd: 'C:\\films\\one' } } }), 'utf8');
  const store = createAcpSessionStore({ file });
  assert.equal(store.get(PROJECT).sessionId, 'session-old');
  assert.equal(store.getSession(PROJECT, '').sessionId, 'session-old');
  store.setSession(PROJECT, 'snew', { sessionId: 'session-new' });
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.version, 2);
  assert.equal(written.projects[PROJECT].sessions[''], 'session-old');
  assert.equal(written.projects[PROJECT].sessions.snew, 'session-new');
});

test('a corrupt or foreign file degrades to empty instead of throwing', () => {
  const dir = scratch();
  const file = join(dir, 'acp-sessions.json');
  writeFileSync(file, '{not json', 'utf8');
  const store = createAcpSessionStore({ file });
  assert.equal(store.get(PROJECT), undefined);
  store.setSession(PROJECT, 'sa', { sessionId: 'x' });
  assert.equal(store.getSession(PROJECT, 'sa').sessionId, 'x');
});

test('invalid ids are ignored, not written', () => {
  const store = createAcpSessionStore();
  store.setSession('bad', 'sa', { sessionId: 'x' });
  store.setSession(PROJECT, 'sa', { sessionId: '' });
  assert.equal(store.getSession(PROJECT, 'sa'), undefined);
  assert.deepEqual(store.all(), []);
});
