// Both sides of the panel read the same conversation record with different caches:
// the sidebar re-reads on a poll, the chat page reheats its own state. Without the
// second half, deleting in the sidebar left the conversation in the session bar
// until a reload. Asserted against the committed patch series (not the upstream
// checkout, which CI does not have).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { transformSync } from 'esbuild';

const read = path => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const series = JSON.parse(read('patches/series.json'));
const patchBySource = source => {
  const entry = series.patches.find(item => item.source === source);
  assert.ok(entry, `missing patch entry in series.json for ${source}`);
  return read(`patches/${entry.file}`);
};
const app = patchBySource('apps/desktop/chat/src/App.tsx');
const store = patchBySource('apps/desktop/chat/src/lib/chat-store.ts');

test('the chat page re-reads the conversation list while it is open', () => {
  assert.match(app, /\+import \{[^}]*\brefreshChatSessions\b[^}]*\} from '@\/lib\/chat-store'/);
  assert.match(app, /\+    const timer = window\.setInterval\(check, 10000\);/);
  assert.match(app, /\+    document\.addEventListener\('visibilitychange', check\);/);
});

test('a deleted current conversation leaves the empty starter, not another one', () => {
  assert.match(app, /setSessionId\(\(current\) => \(current && !list\.some\(\(entry\) => entry\.id === current\) \? '' : current\)\)/);
});

test('the re-read replaces the page copy, drops removed turns, and reports whether it changed', () => {
  assert.match(store, /\+export async function refreshChatSessions/);
  assert.match(store, /\+  if \(stamp\(next\) === stamp\(current\)\) return false;/);
  assert.match(store, /\+  chat\.sessions = next;/);
  assert.match(store, /\+  chat\.turns = chat\.turns\.filter\(entry => !removed\.has\(entry\.turn\.sessionId \?\? ''\)\);/);
});

test('a conversation deleted elsewhere reaches the open page at once, not on the next poll', () => {
  assert.match(app, /no996-openfilm:conversation-deleted/);
  assert.match(app, /addEventListener\('no996-openfilm:conversation-deleted', onDeleted\)/);
  assert.match(app, /removeEventListener\('no996-openfilm:conversation-deleted', onDeleted\)/);
});

// Exercise the executable function from the pinned source patch so the test
// also runs in CI without the ignored upstream checkout.
function requestFixture(load) {
  const source = store.match(/^\+export async function readRequestedConversation\([\s\S]+?^\+}$/m)?.[0];
  assert.ok(source);
  const ts = source.replace(/^\+/gm, '').replace(/^export /, '');
  const chat = { sessions: [{ id: 'last' }], turns: [], last: 'last' };
  const execute = new Function('app', 'readFor', 'record', 'joinKept',
    `${transformSync(ts, { loader: 'ts' }).code}\nreturn readRequestedConversation;`);
  const readFor = new Map([['/film', 'project1']]);
  const read = execute({ chat: { load } }, readFor, () => chat, (record, kept) => {
    record.sessions.push(...kept.sessions.filter(item => !record.sessions.some(row => row.id === item.id)));
    record.turns.push(...kept.turns);
  });
  return { chat, select: (id, current = () => true) => read('/film', 'project1', id, current) };
}

const recent = { id: 'last' };
const original = { id: 'chosen', agentSessions: { deepseek: 'provider-id' } };
const keptTurn = (id, sessionId) => ({ turn: { id, sessionId }, items: [] });

test('a cold explicit handoff reads its own conversation and turns, never the remembered last chat', async () => {
  const { chat, select } = requestFixture(async () => ({
    sessions: [recent, original], last: recent.id,
    turns: [keptTurn('last-turn', recent.id), keptTurn('chosen-turn', original.id)],
  }));
  assert.equal(await select('chosen'), 'ready');
  assert.deepEqual(chat.sessions.at(-1), original);
  assert.deepEqual(chat.turns, [keptTurn('chosen-turn', 'chosen')]);
});

test('missing, archived, unavailable, and late history cannot substitute another chat', async () => {
  let resolve;
  const deferred = new Promise(done => { resolve = done; });
  let live = true;
  const late = requestFixture(() => deferred);
  const earlier = late.select('chosen', () => live);
  live = false;
  resolve({ sessions: [original], turns: [keptTurn('chosen-turn', 'chosen')] });
  assert.equal(await earlier, 'superseded');
  assert.deepEqual(late.chat.sessions, [recent]);
  assert.deepEqual(late.chat.turns, []);
  assert.equal(await requestFixture(async () => ({ sessions: [recent], last: recent.id })).select('chosen'), 'missing');
  assert.equal(await requestFixture(async () => ({ sessions: [{ ...original, archived: true }] })).select('chosen'), 'archived');
  await assert.rejects(requestFixture(async () => { throw new Error('offline'); }).select('chosen'), /offline/);
});

test('explicit handoff suppresses the last conversation and the composer until resolved', () => {
  assert.match(app, /if \(requestedForProject\(\)\) return ''/);
  assert.match(app, /const sessionId = requested \? '' : selectedSessionId/);
  assert.match(app, /if \(requested \|\| !sessionId \|\| !followUpFilled\) return/);
  assert.match(app, /project && chatReady && projectOnRoute/);
  assert.match(app, /data-no996-editing-request/);
});
