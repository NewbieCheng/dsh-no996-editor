// The tap is the only place the panel's live words come from, and the bug it just had was
// ordering, not content: a snapshot overtook the deltas it summarized and the page appended
// them on top of it. These tests pin the wire contract (order, turn ownership, seals) so that
// cannot regress silently again (ADR-0010 §3.2).
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';

/** Start the tap against a loopback listener and return what it wrote. */
async function tap({ token = 'tok' } = {}) {
  const frames = [];
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.token === token) continue; // the admission line is not a frame
        if (message?.t === 'hello') continue; // the handshake is asserted by acp-client, not here
        frames.push(message);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.NO996_OPENFILM_STREAM_PORT = String(server.address().port);
  process.env.NO996_OPENFILM_STREAM_TOKEN = token;

  const { apply } = await import('../src/acp-stream-tap.mjs');
  const handlers = [];
  let dispose = () => {};
  apply({
    on: (name, fn) => handlers.push([name, fn]),
    effect: (register) => { dispose = register() ?? (() => {}); },
  });
  const emit = frame => handlers.find(([name]) => name === 'agent/assistant-stream')[1]({
    agent: { session: { id: 'session-1' } },
    frame,
  });
  const settle = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
  // Wait for the connect handshake before any frame is pushed, or they queue and the
  // order still holds but the timing assertions below get noisy.
  await settle(60);
  return {
    frames,
    emit,
    settle,
    close: async () => {
      // The tap holds the socket open on purpose (a turn can be long); a test must end it.
      dispose();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

const chunk = (text, index, type = 'text-delta') => ({ type: 'chunk', attemptId: 'session-1:1', index, chunk: { type, text } });

test('deltas and snapshots keep one wire order, so a snapshot never overtakes its deltas', async () => {
  const { frames, emit, settle, close } = await tap();
  emit({ type: 'start', attemptId: 'session-1:1', turn: 1, step: 1 });
  emit(chunk('a', 0));
  emit(chunk('b', 1));
  emit({ type: 'end', attemptId: 'session-1:1', turn: 1, step: 1 });
  await settle();

  assert.equal(frames[0].t, 'start');
  const last = frames[frames.length - 1];
  assert.equal(last.t, 'seal');
  assert.equal(last.text, 'ab', 'the seal is the settled attempt');
  // The contract is order, not a fixed count: every snapshot must be exactly the text the
  // deltas before it built. Anything else means it overtook them and the page would append
  // those deltas on top of it.
  let built = '';
  for (const frame of frames) {
    if (frame.t === 'delta') built += frame.text;
    if (frame.t === 'sync' || frame.t === 'seal') {
      assert.equal(frame.text, built, `${frame.t} at position ${frames.indexOf(frame)} summarizes only what arrived before it`);
    }
  }
  assert.equal(built, 'ab');
  assert.equal(frames.every(frame => frame.turn === 1), true);
  assert.equal(frames.every(frame => frame.attempt === 'session-1:1'), true);
  await close();
});

test('a new turn does not seal the previous thought into it', async () => {
  const { frames, emit, settle, close } = await tap();
  emit({ type: 'start', attemptId: 'session-1:1', turn: 1, step: 1 });
  emit(chunk('why', 0, 'reasoning-delta'));
  emit({ type: 'end', attemptId: 'session-1:1', turn: 1, step: 1 });
  await settle();
  const firstTurn = frames.length;
  // The next user message starts a new turn: nothing from turn 1 may be written now.
  emit({ type: 'start', attemptId: 'session-1:2', turn: 2, step: 1 });
  emit(chunk('again', 0, 'reasoning-delta'));
  await settle();

  const after = frames.slice(firstTurn);
  assert.equal(after[0].t, 'start');
  assert.equal(after[0].turn, 2);
  assert.equal(after.filter(frame => frame.t === 'seal').length, 0, 'no seal carrying the old thought');
  const thoughts = frames.filter(frame => frame.kind === 'thought' && frame.t !== 'start');
  assert.equal(thoughts.every(frame => frame.turn === (frame.t === 'seal' ? 1 : frame.turn)), true);
  await close();
});

test('the thought seal is bounded: a huge reasoning block is not re-sent as one frame', async () => {
  const { frames, emit, settle, close } = await tap();
  emit({ type: 'start', attemptId: 'session-1:1', turn: 1, step: 1 });
  emit(chunk('x'.repeat(40 * 1024), 0, 'reasoning-delta'));
  emit({ type: 'end', attemptId: 'session-1:1', turn: 1, step: 1 });
  await settle();
  assert.equal(frames.some(frame => frame.t === 'seal' && frame.kind === 'thought'), false);
  await close();
});
