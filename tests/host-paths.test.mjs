// A file dropped inside the shell iframe has no path of its own: the DSH page
// (which holds Electron's webUtils bridge) answers for it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installHostPathBridge } from '../src/host/host-paths.mjs';

function fakeWindow(bridge) {
  const listeners = [];
  const replies = [];
  return {
    __DSH_HOST_PATHS__: bridge,
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    dispatch(data, source) { for (const fn of listeners) fn({ data, source }); },
    replies,
    send(type, id, file) { return { type, id, file }; },
  };
}

test('a path for a dropped file comes back to the frame that asked', () => {
  const view = fakeWindow({ pathFor: file => (file && file.name === 'clip.mp4' ? 'C:\\media\\clip.mp4' : '') });
  const stop = installHostPathBridge({ window: view });
  const source = { postMessage: (data) => view.replies.push(data) };
  view.dispatch({ type: 'no996:path-for-file', id: 'p1', file: { name: 'clip.mp4' } }, source);
  assert.deepEqual(view.replies, [{ type: 'no996:path-for-file:reply', id: 'p1', path: 'C:\\media\\clip.mp4' }]);
  stop();
});

test('no desktop bridge, or a failing one, answers with an empty path', () => {
  const none = fakeWindow(undefined);
  installHostPathBridge({ window: none });
  none.dispatch({ type: 'no996:path-for-file', id: 'a', file: {} }, { postMessage: d => none.replies.push(d) });
  assert.deepEqual(none.replies, [{ type: 'no996:path-for-file:reply', id: 'a', path: '' }]);

  const broken = fakeWindow({ pathFor: () => { throw new Error('no such file'); } });
  installHostPathBridge({ window: broken });
  broken.dispatch({ type: 'no996:path-for-file', id: 'b', file: {} }, { postMessage: d => broken.replies.push(d) });
  assert.deepEqual(broken.replies, [{ type: 'no996:path-for-file:reply', id: 'b', path: '' }]);
});

test('other messages are left alone, and a gone source cannot break the listener', () => {
  const view = fakeWindow({ pathFor: () => 'C:\\x.mp4' });
  const stop = installHostPathBridge({ window: view });
  view.dispatch({ type: 'something-else', id: 'p1' }, { postMessage: d => view.replies.push(d) });
  assert.equal(view.replies.length, 0);
  view.dispatch({ type: 'no996:path-for-file', id: 'p2', file: {} }, null);
  assert.equal(view.replies.length, 0);
  stop();
  view.dispatch({ type: 'no996:path-for-file', id: 'p3', file: {} }, { postMessage: d => view.replies.push(d) });
  assert.equal(view.replies.length, 0, 'a disposed bridge answers nothing');
});
