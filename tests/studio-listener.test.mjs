import assert from 'node:assert/strict';
import test from 'node:test';
import { bindStudioListener } from '../src/studio/studio-proxy/upstream.mjs';

function mount(errors, { host = '127.0.0.2', listener = 'editor', desktop = true, port = 47822 } = {}) {
  const calls = [];
  const notes = [];
  const result = bindStudioListener({}, { listener, host, port, desktop, report: note => notes.push(note),
    bind: async (_server, address, requested) => {
      calls.push([address, requested]);
      const code = errors.shift();
      if (code) throw Object.assign(new Error('private address and path'), { code });
      return 61000;
    },
  });
  return { result, calls, notes };
}

test('a missing desktop secondary loopback retries the primary loopback on a new port', async () => {
  const { result, calls, notes } = mount(['EADDRNOTAVAIL']);
  assert.deepEqual(await result, { host: '127.0.0.1', port: 61000 });
  assert.deepEqual(calls, [['127.0.0.2', 47822], ['127.0.0.1', 0]]);
  assert.deepEqual(notes, [{ listener: 'editor', bindHost: '127.0.0.2', requestedPort: 47822, desktop: true,
    platform: process.platform, systemCode: 'EADDRNOTAVAIL', recovery: 'primary-loopback' }]);
});

test('a busy preferred port changes only the port, not the desktop address', async () => {
  const { result, calls, notes } = mount(['EADDRINUSE']);
  assert.deepEqual(await result, { host: '127.0.0.2', port: 61000 });
  assert.deepEqual(calls, [['127.0.0.2', 47822], ['127.0.0.2', 0]]);
  assert.equal(notes[0].recovery, 'ephemeral-port');
});

test('terminal listener errors expose no raw message and do not try another address', async () => {
  const { result, calls, notes } = mount(['EACCES'], { host: '127.0.0.1', listener: 'film', port: 0 });
  await assert.rejects(result, { code: 'STUDIO_PROXY_LISTEN_FAILED', message: 'Studio proxy could not listen' });
  assert.deepEqual(calls, [['127.0.0.1', 0]]);
  assert.equal(notes[0].systemCode, 'EACCES');
  assert.equal(notes[0].listener, 'film');
  assert.equal(notes[0].recovery, 'none');
  assert.doesNotMatch(JSON.stringify(notes), /private/);
});
