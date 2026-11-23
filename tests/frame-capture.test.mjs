// The capture host records dictation audio on the embedded frame's behalf
// inside the DSH main frame — the only frame DSH's microphone policy grants.
// These tests drive a scripted AudioContext and check the contract the frame's
// recorder depends on: start ack, a stop that resolves with a valid 16 kHz mono
// WAV, the 120 s cap that finishes a clip by itself, honest refusal reasons,
// and a microphone that is always released.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameCaptureHost } from '../src/studio/frame-capture.mjs';

const AUDIO = 'no996-openfilm:dictation-audio';

/** Scripted capture stack: one synthetic AudioContext with a test-fed processor. */
function fakeStack({ rate = 48000, getUserMediaError = null, contextError = null } = {}) {
  const tracks = [];
  const events = [];
  const mediaDevices = {
    getUserMedia: async () => {
      if (getUserMediaError) throw getUserMediaError;
      const track = { stop() { this.stopped = true; } };
      tracks.push(track);
      return { getTracks: () => tracks };
    },
  };
  const processor = {
    onaudioprocess: null,
    connect() {},
    disconnect() {},
  };
  const context = contextError ? null : {
    sampleRate: rate,
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createScriptProcessor: () => processor,
    close: async () => {},
  };
  const AudioContext = contextError
    ? class { constructor() { throw contextError; } }
    : function FakeAudioContext() { return context; };
  return {
    mediaDevices,
    AudioContext,
    tracks,
    processor,
    /** Feed one audio buffer to the host's processor handler. */
    feed(channelData) {
      events.push({ inputBuffer: { getChannelData: () => channelData } });
      processor.onaudioprocess?.(events.at(-1));
    },
  };
}

const base64Wav = value => {
  const bytes = Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const header = String.fromCharCode(...bytes.subarray(0, 4));
  const wave = String.fromCharCode(...bytes.subarray(8, 12));
  const rate = view.getUint32(24, true);
  const channels = view.getUint16(22, true);
  const bits = view.getUint16(34, true);
  return { header, wave, rate, channels, bits, dataBytes: view.getUint32(40, true) };
};

test('a started clip answers stop with a valid 16 kHz mono WAV and the peak level', async () => {
  const stack = fakeStack({ rate: 48000 });
  const replies = [];
  const host = createFrameCaptureHost({ post: payload => replies.push(payload), ...stack });
  assert.equal(host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'start', id: 'dc-a' }), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies.at(-1), { type: AUDIO, version: 1, id: 'dc-a', ok: true, phase: 'started' });

  const handler = stack.processor.onaudioprocess;
  assert.equal(typeof handler, 'function', 'the host drives the processor');
  // One second of a quiet 48 kHz sine-ish signal: constant low amplitude.
  const second = new Float32Array(48000).fill(0.1);
  handler({ inputBuffer: { getChannelData: () => second } });

  host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'stop', id: 'dc-a' });
  await new Promise(resolve => setImmediate(resolve));
  const reply = replies.at(-1);
  assert.equal(reply.ok, true);
  const wav = base64Wav(reply.audioBase64);
  assert.equal(wav.header + wav.wave, 'RIFFWAVE');
  assert.equal(wav.rate, 16000, 'dictation runs at 16 kHz');
  assert.equal(wav.channels, 1);
  assert.equal(wav.bits, 16);
  assert.equal(wav.dataBytes, 16000 * 2, 'one second downsampled to mono s16');
  assert.ok(Math.abs(reply.durationMs - 1000) < 5);
  assert.ok(Math.abs(reply.rms - 0.1) < 1e-6);
  assert.equal(stack.tracks.every(track => track.stopped !== true), false, 'the microphone is released after stop');
});

test('a refusal carries the honest reason and releases the microphone', async () => {
  const stack = fakeStack({ getUserMediaError: Object.assign(new Error('denied'), { name: 'NotAllowedError' }) });
  const replies = [];
  const host = createFrameCaptureHost({ post: payload => replies.push(payload), ...stack });
  host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'start', id: 'dc-b' });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies.at(-1), { type: AUDIO, version: 1, id: 'dc-b', ok: false, reason: 'micDenied' });
});

test('a frame that cannot reach the media stack reports micUnsupported without throwing', async () => {
  const replies = [];
  const host = createFrameCaptureHost({ post: payload => replies.push(payload) });
  host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'start', id: 'dc-c' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies.at(-1), { type: AUDIO, version: 1, id: 'dc-c', ok: false, reason: 'micUnsupported' });
});

test('the 120 second cap finishes the clip by itself and answers stop from the stash', async () => {
  const stack = fakeStack({ rate: 48000 });
  const replies = [];
  const host = createFrameCaptureHost({ post: payload => replies.push(payload), ...stack });
  host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'start', id: 'dc-d' });
  await new Promise(resolve => setImmediate(resolve));
  const handler = stack.processor.onaudioprocess;
  const second = new Float32Array(48000).fill(0.2);
  // 121 seconds: the cap finalizes during the 121st second.
  for (let i = 0; i < 121; i += 1) handler({ inputBuffer: { getChannelData: () => second } });
  const capped = replies.find(reply => reply.ok === true && typeof reply.audioBase64 === 'string');
  assert.ok(capped, 'the cap auto-finalized the clip');
  assert.equal(Math.round(capped.durationMs / 1000), 120, 'exactly 120 seconds of audio');

  // The late stop is answered from the finished clip, not re-recorded.
  host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'stop', id: 'dc-d' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.filter(reply => reply.ok === true && typeof reply.audioBase64 === 'string').length, 1);
});

test('a stale stop or abort and a garbage id never answer or hold the microphone', async () => {
  const stack = fakeStack();
  const replies = [];
  const host = createFrameCaptureHost({ post: payload => replies.push(payload), ...stack });
  assert.equal(host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'stop', id: 'dc-none' }), true);
  assert.equal(host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'start', id: '../etc' }), true);
  assert.equal(host.handle({ type: 'other-message', version: 1 }), false, 'foreign messages are not consumed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.length, 0, 'no reply went to a garbage or stale request');
  host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'start', id: 'dc-e' });
  await new Promise(resolve => setImmediate(resolve));
  host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'abort', id: 'dc-e' });
  assert.equal(stack.tracks.every(track => track.stopped !== true), false, 'abort releases the microphone');
  host.stopAll();
});

test('a fresh start supersedes a forgotten session so the microphone is never held', async () => {
  const stack = fakeStack();
  const replies = [];
  const host = createFrameCaptureHost({ post: payload => replies.push(payload), ...stack });
  host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'start', id: 'dc-f1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.at(-1).ok, true);
  host.handle({ type: 'no996-openfilm:dictation-capture', version: 1, action: 'start', id: 'dc-f2' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies.at(-1), { type: AUDIO, version: 1, id: 'dc-f2', ok: true, phase: 'started' });
  assert.equal(stack.tracks.length, 2, 'each start opened its own stream');
  assert.equal(stack.tracks[0].stopped, true, 'the superseded stream was released');
  assert.notEqual(stack.tracks[1].stopped, true, 'the new stream is live');
  host.stopAll();
  assert.equal(stack.tracks[1].stopped, true, 'stopAll releases the live stream');
});
