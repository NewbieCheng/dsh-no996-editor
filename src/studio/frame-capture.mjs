// Dictation capture host for the embedded Studio frame.
//
// DSH's desktop microphone policy grants only the primary window's main frame
// (isMainFrame + the dsh-app:// application origin + audio). The Studio shell
// runs as a cross-origin subframe, so its own getUserMedia is refused without a
// prompt, no matter what the person configures — that refusal is what surfaced
// as `micDenied`. This host records on the frame's behalf inside the DSH page,
// which the policy does grant, and hands the finished clip back over the same
// validated postMessage channel the renewal flow uses.
//
// Privacy: the clip lives in memory only, is sent straight to the requesting
// frame, and nothing here is written to disk or to a log.
const REQUEST = 'no996-openfilm:dictation-capture';
const AUDIO = 'no996-openfilm:dictation-audio';
const MAX_SECONDS = 120;
const TARGET_RATE = 16000;
const ID = /^[A-Za-z0-9-]{1,64}$/;

function classify(error) {
  const name = error?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'micDenied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'micMissing';
  return 'micUnavailable';
}

function downsampleTo16k(samples, fromRate) {
  if (!fromRate || fromRate <= TARGET_RATE) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }
  const ratio = fromRate / TARGET_RATE;
  const targetLen = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(targetLen);
  for (let i = 0; i < targetLen; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += samples[j] ?? 0;
      count += 1;
    }
    const avg = count > 0 ? sum / count : 0;
    const clamped = Math.max(-1, Math.min(1, avg));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

function encodeWavBase64(pcm, sampleRate) {
  const dataBytes = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataBytes, true);
  new Int16Array(buffer, 44).set(pcm);
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Create the capture host.
 * @param {object} deps
 * @param {(payload: object) => void} deps.post - Delivers replies to the requesting frame.
 * @param {MediaDevices} [deps.mediaDevices] - Injectable for tests; absent means unsupported.
 * @param {typeof AudioContext} [deps.AudioContext] - Injectable for tests.
 */
export function createFrameCaptureHost({ post, mediaDevices, AudioContext } = {}) {
  const reply = payload => {
    try { post(payload); } catch { /* the frame went away mid-recording */ }
  };
  let session = null;

  const teardown = current => {
    try { current.processor.disconnect(); } catch { /* already gone */ }
    try { current.source.disconnect(); } catch { /* already gone */ }
    try { void current.context.close().catch(() => {}); } catch { /* already gone */ }
    for (const track of current.stream.getTracks()) {
      try { track.stop(); } catch { /* already gone */ }
    }
  };

  function finalize(state) {
    if (state.finished) return;
    state.finished = true;
    if (session === state) session = null;
    teardown(state);
    const flat = state.chunks.length === 1 ? state.chunks[0] : (() => {
      const merged = new Float32Array(state.samples);
      let at = 0;
      for (const piece of state.chunks) { merged.set(piece, at); at += piece.length; }
      return merged;
    })();
    const pcm = downsampleTo16k(flat, state.rate);
    reply({
      type: AUDIO, version: 1, id: state.id, ok: true,
      audioBase64: encodeWavBase64(pcm, TARGET_RATE),
      durationMs: Math.round((state.samples / state.rate) * 1000),
      rms: Math.sqrt(state.squareSum / Math.max(1, state.samples)),
    });
  }

  async function start(id) {
    // One clip at a time: a fresh start supersedes a stale session whose frame
    // never said stop, so the microphone is never held by a forgotten capture.
    if (session) {
      const stale = session;
      session = null;
      stale.finished = true;
      teardown(stale);
    }
    if (!mediaDevices?.getUserMedia || typeof AudioContext !== 'function') {
      reply({ type: AUDIO, version: 1, id, ok: false, reason: 'micUnsupported' });
      return;
    }
    let stream;
    try {
      stream = await mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      reply({ type: AUDIO, version: 1, id, ok: false, reason: classify(error) });
      return;
    }
    let context;
    let source;
    let processor;
    try {
      context = new AudioContext();
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(context.destination);
    } catch {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* already gone */ }
      }
      reply({ type: AUDIO, version: 1, id, ok: false, reason: 'micUnavailable' });
      return;
    }
    const state = {
      id, stream, context, source, processor,
      rate: context.sampleRate,
      chunks: [], samples: 0, squareSum: 0, finished: false,
    };
    session = state;
    const maxSamples = MAX_SECONDS * state.rate;
    processor.onaudioprocess = event => {
      if (state.finished) return;
      const input = event.inputBuffer.getChannelData(0);
      const take = Math.min(input.length, Math.max(0, maxSamples - state.samples));
      if (take > 0) {
        const piece = take === input.length ? input : input.subarray(0, take);
        state.chunks.push(Float32Array.from(piece));
        state.samples += take;
        for (let i = 0; i < piece.length; i += 1) {
          const v = piece[i];
          state.squareSum += v * v;
        }
      }
      if (state.samples >= maxSamples) finalize(state);
    };
    reply({ type: AUDIO, version: 1, id, ok: true, phase: 'started' });
  }

  return {
    /** Handle one validated frame message. Returns false when it is not ours. */
    handle(data) {
      if (!data || typeof data !== 'object' || data.type !== REQUEST || data.version !== 1) return false;
      const id = typeof data.id === 'string' && ID.test(data.id) ? data.id : '';
      if (!id) return true; // shaped like ours but broken: swallow, never answer a garbage id
      if (data.action === 'start') void start(id);
      else if (data.action === 'stop') {
        const state = session;
        if (state && state.id === id) finalize(state);
      } else if (data.action === 'abort') {
        const state = session;
        if (state && state.id === id) {
          state.finished = true;
          session = null;
          teardown(state);
        }
      }
      return true;
    },
    /** The panel is being torn down or the frame replaced: release the microphone. */
    stopAll() {
      const state = session;
      session = null;
      if (state && !state.finished) {
        state.finished = true;
        teardown(state);
      }
    },
  };
}
