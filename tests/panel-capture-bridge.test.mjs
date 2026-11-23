// The panel's message bridge must route the shell frame's dictation-capture
// requests into the capture host and its replies back to that exact frame —
// this is the wiring that makes Studio dictation work on DSH's microphone
// policy (main frame only). Foreign senders and origins stay excluded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioPanel } from '../src/studio/studio-panel.mjs';

// Minimal hook harness: exercises the real component without a browser or model.
function mount(Panel, props) {
  const hooks = [], effects = []; let cursor = 0, tree;
  const React = {
    createElement: (type, attributes, ...children) => ({ type, props: attributes || {}, children }),
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ||= { current: initial }; },
    useEffect(fn, deps) { const i = cursor++; const old = hooks[i]; if (!old || deps.some((x, n) => x !== old.deps[n])) { effects.push(() => { old?.cleanup?.(); hooks[i] = { deps, cleanup: fn() }; }); } },
  };
  const Component = Panel(React);
  function render() { cursor = 0; tree = Component(props); while (effects.length) effects.shift()(); return tree; }
  return { render, close: () => hooks.forEach(h => h?.cleanup?.()) };
}
const find = (node, type) => {
  if (!node || typeof node !== 'object') return [];
  return [...(node.type === type ? [node] : []), ...node.children.flatMap(child => Array.isArray(child) ? child.flatMap(x => find(x, type)) : find(child, type))];
};
const cleanup = () => { delete globalThis.window; delete globalThis.document; delete globalThis.localStorage; };
const browser = (overrides = {}) => {
  globalThis.window = {
    location: { protocol: 'dsh-app:', host: 'app', hostname: 'app' },
    addEventListener: () => {}, removeEventListener: () => {},
    ...overrides,
  };
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

const ORIGIN = 'http://127.0.0.2:47822';
const startStudio = async () => ({ editorOrigin: ORIGIN, ticket: 'a'.repeat(32) });

test('a dictation-capture request from the shell frame is served by the capture host', async () => {
  let receive;
  browser({ addEventListener: (type, fn) => { if (type === 'message') receive = fn; } });
  const panel = mount(createStudioPanel, { t: key => key, startStudio });
  try {
    panel.render(); await settle();
    const frame = find(panel.render(), 'iframe')[0];
    const posts = [];
    frame.props.ref.current = { contentWindow: { postMessage: (data, origin) => posts.push({ data, origin }) } };

    // No real media stack in Node: the host answers micUnsupported — the point
    // here is the wiring, not the capture math (covered by frame-capture tests).
    receive({ origin: ORIGIN, source: frame.props.ref.current.contentWindow, data: { type: 'no996-openfilm:dictation-capture', version: 1, action: 'start', id: 'dc-w1' } });
    await settle(); await settle();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].data.type, 'no996-openfilm:dictation-audio');
    assert.equal(posts[0].data.id, 'dc-w1');
    assert.equal(posts[0].data.ok, false);
    assert.equal(posts[0].data.reason, 'micUnsupported');
    assert.equal(posts[0].origin, ORIGIN, 'replies go to the frame origin only');
  } finally { panel.close(); cleanup(); }
});

test('a dictation request from a foreign sender or origin is ignored', async () => {
  let receive;
  browser({ addEventListener: (type, fn) => { if (type === 'message') receive = fn; } });
  const panel = mount(createStudioPanel, { t: key => key, startStudio });
  try {
    panel.render(); await settle();
    const frame = find(panel.render(), 'iframe')[0];
    const posts = [];
    frame.props.ref.current = { contentWindow: { postMessage: (data, origin) => posts.push({ data, origin }) } };
    const message = { type: 'no996-openfilm:dictation-capture', version: 1, action: 'start', id: 'dc-x' };

    receive({ origin: 'https://evil.example', source: frame.props.ref.current.contentWindow, data: message });
    receive({ origin: ORIGIN, source: { postMessage: () => {} }, data: message });
    await settle(); await settle();
    assert.equal(posts.length, 0, 'neither a wrong origin nor a wrong sender reaches the host');
  } finally { panel.close(); cleanup(); }
});
