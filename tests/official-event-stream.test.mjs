import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createOfficialEventHub } from '../src/official/official-event-hub.mjs';
import { attachOfficialEventStream } from '../src/official/official-event-stream.mjs';

class Response extends EventEmitter {
  chunks = [];
  writableEnded = false;
  full = false;
  writeHead() {}
  write(chunk) {
    if (this.writableEnded) return false;
    // Node accepts the chunk and reports backpressure; it never drops bytes.
    if (this.full) { this.chunks.push(chunk); return false; }
    this.chunks.push(chunk);
    return true;
  }
  end() { this.writableEnded = true; }
}
const dataEvents = response => response.chunks
  .filter(chunk => typeof chunk === 'string' && chunk.startsWith('data: '))
  .map(chunk => JSON.parse(chunk.slice(6).trim()));

test('hub writes updates and terminal in SSE order on the same connection', () => {
  const hub = createOfficialEventHub(), response = new Response();
  const close = attachOfficialEventStream({ hub, projectId: 'project1', response });
  assert.equal(hub.publish('project1', { key: 'key', kind: 'update', update: { text: 'hello' } }), true);
  assert.equal(hub.publish('project1', { key: 'key', turnId: 'turn', kind: 'done', ok: true, stopReason: 'end_turn' }), true);
  const events = dataEvents(response);
  assert.deepEqual(events.map(event => event.kind), ['update', 'done']);
  assert.equal(events[1].turnId, 'turn');
  // The browser reconnects on its own; we only supply the delay hint.
  assert.match(response.chunks[0], /^retry: 3000/);
  close();
  assert.equal(hub.publish('project1', { kind: 'update' }), false);
});

test('backpressure queues frames instead of killing a live turn', () => {
  const hub = createOfficialEventHub(), response = new Response();
  const close = attachOfficialEventStream({ hub, projectId: 'project1', response });
  response.full = true; // the socket buffer is full, the client is still there
  assert.equal(hub.publish('project1', { key: 'k', kind: 'update', update: { seq: 1 } }), true);
  assert.equal(hub.publish('project1', { key: 'k', kind: 'update', update: { seq: 2 } }), true);
  assert.equal(hub.publish('project1', { key: 'k', kind: 'done', ok: true, stopReason: 'end_turn' }), true);
  assert.equal(response.writableEnded, false, 'a slow socket must not be treated as a disconnect');
  // Node already buffered the first chunk; only the return value signalled
  // backpressure, so exactly one frame is out and the rest wait for drain.
  assert.equal(dataEvents(response).length, 1);

  // The socket drains: every queued frame is flushed in order, terminal last.
  response.full = false;
  response.emit('drain');
  assert.deepEqual(dataEvents(response).map(event => event.kind), ['update', 'update', 'done']);
  assert.deepEqual(dataEvents(response).map(event => event.update?.seq ?? null), [1, 2, null]);
  close();
});

test('a backlog over the hard cap closes instead of growing forever', () => {
  const hub = createOfficialEventHub(), response = new Response();
  const close = attachOfficialEventStream({ hub, projectId: 'project1', response });
  response.full = true;
  let accepted = 0;
  for (let i = 0; i < 5000; i++) if (hub.publish('project1', { key: 'k', kind: 'update', update: { i } }) === true) accepted++;
  assert.ok(accepted < 5000, 'an unbounded dead reader must stop being accepted');
  assert.equal(response.writableEnded, true);
  close();
});

test('a reconnecting page resumes after the last sequence it applied', () => {
  const hub = createOfficialEventHub();
  const first = new Response();
  const closeFirst = attachOfficialEventStream({ hub, projectId: 'project1', response: first });
  for (const index of [1, 2, 3, 4]) hub.publish('project1', { key: 'key', kind: 'update', update: { index } });
  assert.deepEqual(dataEvents(first).map(event => event.seq), [1, 2, 3, 4]);
  closeFirst();

  // The socket died after sequence 2 was applied: only 3 and 4 are replayed, and
  // the live frames continue from there without repeating them.
  const resumed = new Response();
  const closeResumed = attachOfficialEventStream({ hub, projectId: 'project1', response: resumed, afterSeq: 2 });
  hub.publish('project1', { key: 'key', kind: 'done', turnId: 't1', ok: true, stopReason: 'end_turn' });
  assert.deepEqual(dataEvents(resumed).map(event => event.seq), [3, 4, 5]);
  assert.deepEqual(dataEvents(resumed).map(event => event.kind), ['update', 'update', 'done']);
  closeResumed();
});

test('the tail is bounded so a long turn cannot grow without limit', () => {
  const hub = createOfficialEventHub();
  const first = new Response();
  const closeFirst = attachOfficialEventStream({ hub, projectId: 'project1', response: first });
  for (let index = 1; index <= 500; index += 1) hub.publish('project1', { key: 'key', kind: 'update', update: { index } });
  closeFirst();
  const resumed = new Response();
  const closeResumed = attachOfficialEventStream({ hub, projectId: 'project1', response: resumed, afterSeq: 0 });
  const replayed = dataEvents(resumed);
  assert.ok(replayed.length > 0 && replayed.length <= 400, `replayed ${replayed.length}`);
  assert.equal(replayed.at(-1).seq, 500);
  assert.deepEqual(replayed.map(event => event.seq), replayed.map((_, index) => replayed[0].seq + index));
  closeResumed();
});
