import test from 'node:test';
import assert from 'node:assert/strict';
import { createStallWatch, stallReason, linkSignals } from '../src/host/download-stall.mjs';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('connect phase aborts when headers never arrive', async () => {
  const stalls = [];
  const watch = createStallWatch({ connectMs: 40, idleMs: 500, onStall: e => stalls.push(e) });
  await wait(80);
  assert.equal(watch.signal.aborted, true);
  assert.equal(stalls[0]?.code, 'DOWNLOAD_CONNECT_TIMEOUT');
  assert.equal(stallReason(watch.signal.reason)?.code, 'DOWNLOAD_CONNECT_TIMEOUT');
  watch.clear();
});

test('idle phase aborts only when bytes stop, not while they keep arriving', async () => {
  const watch = createStallWatch({ connectMs: 500, idleMs: 50 });
  watch.connected();
  for (let i = 0; i < 4; i += 1) {
    await wait(25);
    watch.activity();
  }
  assert.equal(watch.signal.aborted, false);
  await wait(80);
  assert.equal(watch.signal.aborted, true);
  assert.equal(stallReason(watch.signal.reason)?.code, 'DOWNLOAD_STALL');
  watch.clear();
});

test('clear() stops the timer so a finished download is not aborted late', async () => {
  const watch = createStallWatch({ connectMs: 30, idleMs: 30 });
  watch.connected();
  watch.activity();
  watch.clear();
  await wait(80);
  assert.equal(watch.signal.aborted, false);
});

test('linkSignals aborts when either side aborts', async () => {
  const a = new AbortController();
  const b = new AbortController();
  const linked = linkSignals(a.signal, b.signal);
  assert.equal(linked.aborted, false);
  b.abort(Object.assign(new Error('cancel'), { code: 'ABORTED' }));
  await wait(0);
  assert.equal(linked.aborted, true);
});
