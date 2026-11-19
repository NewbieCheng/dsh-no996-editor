import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioPanel } from '../src/studio/studio-panel.mjs';

/*
 * The preview's fullscreen button lives inside the editor frame, and a
 * cross-origin frame only gets fullscreen when this host delegates it. The
 * renewal path exists because the frame's own credential lapses: the panel must
 * extend the frame it already has rather than reload it, or unsaved edits and
 * every live connection go with it.
 */

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
function find(node, type) {
  if (!node || typeof node !== 'object') return [];
  return [...(node.type === type ? [node] : []), ...node.children.flatMap(child => Array.isArray(child) ? child.flatMap(x => find(x, type)) : find(child, type))];
}
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

test('the validated editor frame is the only one granted fullscreen', async () => {
  browser();
  const panel = mount(createStudioPanel, { t: key => key, startStudio: async () => ({ editorOrigin: 'http://127.0.0.2:47822', ticket: 'a'.repeat(32) }) });
  try {
    panel.render(); await settle();
    const frame = find(panel.render(), 'iframe')[0];
    assert.equal(frame.props.allowFullScreen, true, 'the preview button needs the delegation');
    assert.match(frame.props.allow, /(^|;)\s*fullscreen\s*(;|$)/);
    assert.match(frame.props.allow, /clipboard-read/, 'clipboard delegation must survive the change');
    assert.equal(frame.props.sandbox, undefined, 'a sandbox would break dropping a video onto the chat');
  } finally { panel.close(); cleanup(); }
});

test('a due renewal posts a fresh grant to the open frame and never rebuilds it', async () => {
  let receive;
  browser({ addEventListener: (type, fn) => { if (type === 'message') receive = fn; } });
  const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout, realFetch = globalThis.fetch;
  const timers = [];
  globalThis.setTimeout = (fn, ms, ...args) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = () => {};
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), body: options?.body });
    return { ok: true, json: async () => ({ ticket: 'b'.repeat(43), sessionExpiresIn: 60 }) };
  };
  let starts = 0;
  const panel = mount(createStudioPanel, {
    t: key => key,
    startStudio: async () => { starts++; return { editorOrigin: 'http://127.0.0.2:47822', ticket: 'a'.repeat(32), sessionExpiresIn: 600 }; },
  });
  try {
    panel.render(); await settle();
    const frame = find(panel.render(), 'iframe')[0];
    const posts = [];
    frame.props.ref.current = { contentWindow: { postMessage: (data, origin) => posts.push({ data, origin }) } };
    // 600 s lifetime with a 120 s margin: the first renewal is due after 480 s.
    const due = timers.find(timer => timer.ms > 400000 && timer.ms <= 480000);
    assert.ok(due, `expected a renewal before the deadline, got ${timers.map(t => t.ms).join(',')}`);

    due.fn();
    await settle(); await settle(); await settle();
    const renewal = requests.find(request => request.url === '/api/no996-openfilm/renew-session');
    assert.ok(renewal, 'the panel asks the Host for a grant');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].data.type, 'no996-openfilm:renew-session');
    assert.equal(posts[0].data.ticket, 'b'.repeat(43));
    assert.equal(posts[0].origin, 'http://127.0.0.2:47822');

    // The frame confirms the cookie was extended: the next renewal follows the
    // grant's own lifetime (60 s, 12 s margin).
    receive({ origin: 'http://127.0.0.2:47822', source: frame.props.ref.current.contentWindow, data: { type: 'no996-openfilm:renewed', version: 1, ok: true } });
    await settle();
    assert.ok(timers.some(timer => timer.ms > 40000 && timer.ms <= 48000), 'the next renewal follows the refreshed lifetime');
    // Nothing above replaced the frame: no reload, no lost editing state.
    const after = find(panel.render(), 'iframe')[0];
    assert.equal(after.props.src, frame.props.src);
    assert.equal(starts, 1);
  } finally {
    panel.close();
    globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClear; globalThis.fetch = realFetch;
    cleanup();
  }
});

test('a refused renewal is retried instead of waiting for the credential to lapse', async () => {
  browser();
  const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout, realFetch = globalThis.fetch;
  const timers = [];
  globalThis.setTimeout = (fn, ms, ...args) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = () => {};
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('offline'); };
  const panel = mount(createStudioPanel, {
    t: key => key,
    startStudio: async () => ({ editorOrigin: 'http://127.0.0.2:47822', ticket: 'a'.repeat(32), sessionExpiresIn: 600 }),
  });
  try {
    panel.render(); await settle();
    const frame = find(panel.render(), 'iframe')[0];
    frame.props.ref.current = { contentWindow: { postMessage: () => { throw new Error('frame gone'); } } };
    const due = timers.find(timer => timer.ms > 400000 && timer.ms <= 480000);
    assert.ok(due);
    due.fn();
    await settle(); await settle(); await settle();
    assert.equal(calls, 1);
    const retry = timers.find(timer => timer.ms > 0 && timer.ms <= 2000 && timer.ms !== 480000);
    assert.ok(retry, `expected a short retry, got ${timers.map(t => t.ms).join(',')}`);
  } finally {
    panel.close();
    globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClear; globalThis.fetch = realFetch;
    cleanup();
  }
});
