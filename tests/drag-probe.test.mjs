// The probe answers one question only: which layer saw the drag at all.
import assert from 'node:assert/strict';
import test from 'node:test';
import { installDragProbe } from '../src/drag-probe.mjs';

function fakeWindow() {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => { listeners.set(type + (fn.name || ''), fn); (listeners.get(type) || listeners.set(type, []).get(type)).push?.(fn); },
    removeEventListener: () => {},
    emit(type, event) { for (const fn of listeners.get(type) ?? []) fn(event); },
    count: () => [...listeners.values()].reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0),
  };
}

function harness() {
  const listeners = new Map();
  const sent = [];
  const view = {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener() {},
  };
  const send = (endpoint, init) => { sent.push(JSON.parse(init.body)); return Promise.resolve({ ok: true }); };
  return { view, sent, send, emit(type, event) { for (const fn of listeners.get(type) ?? []) fn(event); } };
}

test('a file drag is reported once per type with what the layer saw', () => {
  const { view, sent, send, emit } = harness();
  installDragProbe({ window: view, layer: 'host', fetch: send });
  const files = [{ name: 'a.mp4' }];
  emit('dragover', { dataTransfer: { types: ['Files'], files }, target: { tagName: 'DIV' } });
  emit('dragover', { dataTransfer: { types: ['Files'], files }, target: { tagName: 'DIV' } });
  const probes = sent.filter(entry => entry.type !== 'boot');
  assert.equal(probes.length, 2, 'both sightings within the limit are kept');
  assert.deepEqual(probes[0], { layer: 'host', type: 'dragover', types: 'Files', files: 1, target: 'DIV' });
  // the DSH page's own endpoint, not the editor proxy's channel wrapper
  assert.equal(sent[0].channel, undefined);
});

test('non-file drags are ignored, and a failing report cannot break the page', () => {
  const { view, sent, emit } = harness();
  installDragProbe({ window: view, layer: 'shell', fetch: () => { throw new Error('offline'); } });
  emit('dragover', { dataTransfer: { types: ['text/plain'], files: [] } });
  assert.equal(sent.length, 0);
  emit('drop', { dataTransfer: { types: ['Files'], files: [] }, target: null });
  assert.equal(sent.length, 0);
});

test('the probe reports its boot even before any drag', () => {
  const { view, sent, send } = harness();
  installDragProbe({ window: view, layer: 'shell', fetch: send });
  assert.equal(sent[0].type, 'boot');
  assert.equal(sent[0].layer, 'shell');
});
