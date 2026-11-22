// Both sides of the panel read the same conversation record with different caches:
// the sidebar re-reads on a poll, the chat page reheats its own state. Without the
// second half, deleting in the sidebar left the conversation in the session bar
// until a reload. Asserted against the committed patch series (not the upstream
// checkout, which CI does not have).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
  assert.match(app, /\+import \{ refreshChatSessions \} from '@\/lib\/chat-store'/);
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
