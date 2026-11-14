// The frame that holds the official UI may never see an OS file drag; the DSH
// page does, so it catches the drop while the panel is on screen.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDropCatcher } from '../src/drop-catcher.mjs';

function harness(active = true) {
  const handlers = new Map();
  const posted = [];
  const nodes = [];
  const doc = {
    body: { append: node => nodes.push(node) },
    createElement: () => {
      const node = {
        attr: {}, style: { cssText: '' }, children: [], removed: false,
        setAttribute(k, v) { node.attr[k] = v; },
        append(child) { node.children.push(child); },
        addEventListener(type, fn) { node[type] = fn; },
        remove() { node.removed = true; },
      };
      return node;
    },
  };
  const view = {
    addEventListener(type, fn, capture) { handlers.set(type, fn); },
    removeEventListener() {},
  };
  const frame = { postMessage: message => posted.push(message) };
  const stop = installDropCatcher({ window: view, document: doc, isActive: () => active, frame: () => frame });
  return { nodes, posted, handlers, stop, doc };
}

const fileDrag = () => ({ dataTransfer: { types: ['Files'], files: [{ name: 'clip.mp4' }] } });

test('a file dragged over the panel opens a catcher and the drop lands in the chat', () => {
  const { nodes, posted, handlers } = harness();
  handlers.get('dragenter')(fileDrag());
  assert.equal(nodes.length, 1, 'one overlay appears');
  const overlay = nodes[0];
  assert.equal(overlay.attr['data-no996-drop-catcher'], '');

  const drop = { preventDefault() { drop.defaultPrevented = true; }, dataTransfer: { files: [{ name: 'clip.mp4' }] } };
  overlay.drop(drop);
  assert.equal(drop.defaultPrevented, true);
  assert.equal(overlay.removed, true, 'the overlay goes away with the drop');
  assert.deepEqual(posted, [{ type: 'no996:attach-files', files: [{ name: 'clip.mp4' }] }]);
});

test('nothing is caught while the panel is not the page on screen', () => {
  const { nodes, posted, handlers } = harness(false);
  handlers.get('dragenter')(fileDrag());
  assert.equal(nodes.length, 0);
  assert.equal(posted.length, 0);
});

test('a drag that is not a file, or that ends outside, leaves nothing behind', () => {
  const { nodes, handlers } = harness();
  handlers.get('dragenter')({ dataTransfer: { types: ['text/plain'], files: [] } });
  assert.equal(nodes.length, 0);
  handlers.get('dragenter')(fileDrag());
  handlers.get('dragend')();
  assert.equal(nodes[0].removed, true);
});

test('a missing frame does not throw on drop', () => {
  const { nodes, handlers } = harness();
  const stop = installDropCatcher({
    window: { addEventListener(type, fn) { handlers.set(type, fn); }, removeEventListener() {} },
    document: nodes.doc,
    isActive: () => true,
    frame: () => null,
  });
  handlers.get('dragenter')(fileDrag());
  assert.doesNotThrow(() => nodes[0].drop({ preventDefault() {}, dataTransfer: { files: [{ name: 'x' }] } }));
  stop();
});
