/**
 * Pure Node.js deterministic procedural SFX synthesizer & stereo stem mixer.
 *
 * Distilled from `anxiety-vibe/tools/mix_audio.py` and `vibe-bgm-skill/scripts/sfx.py`,
 * rewritten in dependency-free JS (48 kHz stereo 16-bit PCM WAV) so every OpenFilm
 * project can synthesize crisp action sounds on any OS without Python/scipy/numpy.
 *
 * OpenFilm protocol contract (`SPEC.md` §Sound):
 *   1. Pages have no sound; every sound is an `<audio>` clip in `film.html`.
 *   2. Clips on the same `<section>` track MUST NOT overlap.
 *   Therefore we provide two modes:
 *     - `clips`: individual short `.wav` files + greedy non-overlapping lane packing;
 *     - `stem`: sample-accurate offline stereo mix (`sfx-stem.wav`) with `-1.2 dBFS`
 *       soft ceiling for high-density sequences (e.g. 96-cell simulation clicks).
 */

export const SFX_SAMPLE_RATE = 48000;
const TWO_PI = Math.PI * 2;

export const SFX_CATALOG = Object.freeze({
  hit: { duration: 0.70, desc: '深沉低频重击（大字砸入、主论点落地、翻页落锤）' },
  thud: { duration: 0.35, desc: '紧凑沉闷顿击（标签胶囊、门关闭撞击、柱体落定）' },
  click: { duration: 0.06, desc: '高频清脆微点（批量模拟格点、高频闪烁数据点）' },
  tick: { duration: 0.12, desc: '机械刻度滴答（倒计时、进度步进、网格打卡）' },
  pop: { duration: 0.25, desc: '轻快气泡弹出（卡片登场、数字提示、小组件亮起）' },
  whoosh: { duration: 0.55, desc: '上升带通扫风（扫屏转场、元素横穿；建议提前 0.18s 起扫）' },
  down: { duration: 0.40, desc: '下行滑音（成本降低、能量消耗、指标回落）' },
  up: { duration: 0.50, desc: '上扬双谐波滑音（能力提升、扩容反转、正反馈抬升）' },
  bell: { duration: 1.60, desc: '金属泛音清脆钟鸣（可配 pitch Hz；完成打勾、关键确认）' },
  crack: { duration: 0.40, desc: '干脆碎裂声（大块拆解、结构裂开）' },
  typing: { duration: 0.09, desc: '机械键盘敲击（打字机字幕、终端命令）' },
  wood: { duration: 0.22, desc: '温润木鱼敲击（手绘板书、知识要点切出）' },
});

export const SFX_KINDS = Object.freeze(Object.keys(SFX_CATALOG));

/** Deterministic Mulberry32 PRNG in [-1, 1] for white noise synthesis. */
function createRng(seed = 410) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** Second-order biquad IIR filter (RBJ Audio EQ Cookbook). */
function biquadFilter(input, type, freq, q = 0.7071, sr = SFX_SAMPLE_RATE) {
  const w0 = (TWO_PI * Math.min(Math.max(freq, 20), sr * 0.45)) / sr;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Math.max(q, 0.1));

  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cosW0) / 2;
    b1 = 1 - cosW0;
    b2 = (1 - cosW0) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW0;
    a2 = 1 - alpha;
  } else if (type === 'highpass') {
    b0 = (1 + cosW0) / 2;
    b1 = -(1 + cosW0);
    b2 = (1 + cosW0) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosW0;
    a2 = 1 - alpha;
  } else {
    // bandpass (constant 0 dB peak gain)
    b0 = alpha;
    b1 = 0;
    b2 = -alpha;
    a0 = 1 + alpha;
    a1 = -2 * cosW0;
    a2 = 1 - alpha;
  }

  const invA0 = 1 / a0;
  const nb0 = b0 * invA0, nb1 = b1 * invA0, nb2 = b2 * invA0;
  const na1 = a1 * invA0, na2 = a2 * invA0;
  const out = new Float64Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    out[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return out;
}

const env = (t, attack, decay) => Math.min(1, t / Math.max(attack, 1e-5)) * Math.exp(-t / Math.max(decay, 1e-4));

function noiseArray(len, rng) {
  const arr = new Float64Array(len);
  for (let i = 0; i < len; i += 1) arr[i] = rng();
  return arr;
}

function fadeEdges(buf, fadeSamples = 96) {
  const n = buf.length;
  for (let i = 0; i < Math.min(fadeSamples, n); i += 1) {
    buf[i] *= i / fadeSamples;
    buf[n - 1 - i] *= i / fadeSamples;
  }
  return buf;
}

/**
 * Synthesize one mono SFX signal at 48 kHz in [-1, 1].
 * @param {string} kind - one of `SFX_KINDS`
 * @param {object} [opts]
 * @param {number} [opts.duration] - override duration in seconds (0.02..10)
 * @param {number} [opts.pitch=698.46] - fundamental Hz for `bell`
 * @param {number} [opts.seed=410]
 * @returns {Float64Array}
 */
export function synthesizeSfxMono(kind, opts = {}) {
  const meta = SFX_CATALOG[kind];
  if (!meta) throw new Error(`未知音效类型 "${kind}"（支持：${SFX_KINDS.join(', ')}）`);
  const duration = opts.duration !== undefined
    ? Math.min(10, Math.max(0.02, Number(opts.duration)))
    : meta.duration;
  const pitch = opts.pitch !== undefined ? Math.min(10000, Math.max(20, Number(opts.pitch))) : 698.46;
  const seed = Number.isFinite(Number(opts.seed)) ? Math.trunc(Number(opts.seed)) : 410;
  const rng = createRng(seed);
  const total = Math.max(1, Math.round(duration * SFX_SAMPLE_RATE));
  const out = new Float64Array(total);

  if (kind === 'hit') {
    const noiseA = biquadFilter(noiseArray(total, rng), 'lowpass', 900);
    const noiseB = biquadFilter(noiseArray(total, rng), 'highpass', 3000);
    let phase = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / SFX_SAMPLE_RATE;
      const f = 38 + 70 * Math.exp(-t * 28);
      phase += (TWO_PI * f) / SFX_SAMPLE_RATE;
      out[i] = Math.sin(phase) * env(t, 0.002, 0.16) * 0.92
        + noiseA[i] * env(t, 0.001, 0.05) * 0.55
        + noiseB[i] * env(t, 0.001, 0.03) * 0.15;
    }
  } else if (kind === 'thud') {
    const noise = biquadFilter(noiseArray(total, rng), 'lowpass', 1200);
    let phase = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / SFX_SAMPLE_RATE;
      const f = 55 + 60 * Math.exp(-t * 40);
      phase += (TWO_PI * f) / SFX_SAMPLE_RATE;
      out[i] = Math.sin(phase) * env(t, 0.002, 0.07) * 0.85
        + noise[i] * env(t, 0.001, 0.02) * 0.45;
    }
  } else if (kind === 'click') {
    const noise = biquadFilter(noiseArray(total, rng), 'bandpass', 3200, 1.2);
    const f = 1800 + ((rng() + 1) * 0.5) * 900;
    for (let i = 0; i < total; i += 1) {
      const t = i / SFX_SAMPLE_RATE;
      out[i] = noise[i] * env(t, 0.0005, 0.008) * 0.8 + Math.sin(TWO_PI * f * t) * env(t, 0.0005, 0.01) * 0.3;
    }
  } else if (kind === 'tick') {
    const noise = biquadFilter(noiseArray(total, rng), 'bandpass', 5200, 1.5);
    for (let i = 0; i < total; i += 1) {
      const t = i / SFX_SAMPLE_RATE;
      out[i] = Math.sin(TWO_PI * 1760 * t) * env(t, 0.001, 0.025) * 0.5
        + noise[i] * env(t, 0.0005, 0.01) * 0.32;
    }
  } else if (kind === 'pop') {
    let phase = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / SFX_SAMPLE_RATE;
      const f = 420 + 700 * (1 - Math.exp(-t * 40));
      phase += (TWO_PI * f) / SFX_SAMPLE_RATE;
      out[i] = Math.sin(phase) * env(t, 0.002, 0.05) * 0.65;
    }
  } else if (kind === 'whoosh') {
    const noise = noiseArray(total, rng);
    const segments = 12;
    for (let s = 0; s < segments; s += 1) {
      const a = Math.floor((s * total) / segments);
      const b = Math.floor(((s + 1) * total) / segments);
      const fc = 420 + 4800 * ((s / segments) ** 1.6);
      const filtered = biquadFilter(noise, 'bandpass', fc, 1.6);
      for (let i = a; i < b; i += 1) {
        const w = Math.sin((Math.PI * i) / Math.max(1, total - 1)) ** 2.2;
        out[i] = filtered[i] * w * 0.95;
      }
    }
  } else if (kind === 'down') {
    let phase = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / SFX_SAMPLE_RATE;
      const f = 700 * Math.exp(-t * 3.2) + 120;
      phase += (TWO_PI * f) / SFX_SAMPLE_RATE;
      out[i] = Math.sin(phase) * env(t, 0.003, 0.12) * 0.58;
    }
  } else if (kind === 'up') {
    let p1 = 0;
    let p2 = 0;
    for (let i = 0; i < total; i += 1) {
      const t = i / SFX_SAMPLE_RATE;
      const f = 330 * Math.exp(t * 2.4);
      p1 += (TWO_PI * f) / SFX_SAMPLE_RATE;
      p2 += (TWO_PI * f * 1.5) / SFX_SAMPLE_RATE;
      out[i] = Math.sin(p1) * Math.min(1, t / 0.01) * Math.exp(-t / 0.25) * 0.48
        + Math.sin(p2) * Math.exp(-t / 0.2) * 0.2;
    }
  } else if (kind === 'bell') {
    const partials = [
      [1, 0.6, 2.6],
      [2.0, 0.22, 3.6],
      [2.76, 0.12, 5.0],
      [5.4, 0.06, 8.0],
    ];
    for (let i = 0; i < total; i += 1) {
      const t = i / SFX_SAMPLE_RATE;
      let v = 0;
      for (const [r, amp, dec] of partials) {
        v += amp * Math.sin(TWO_PI * pitch * r * t) * Math.exp(-t * dec);
      }
      out[i] = v * Math.min(1, t / 0.002) * 0.72;
    }
  } else if (kind === 'crack') {
    const noise = biquadFilter(noiseArray(total, rng), 'highpass', 1200);
    for (let i = 0; i < total; i += 1) {
      const t = i / SFX_SAMPLE_RATE;
      out[i] = noise[i] * env(t, 0.0005, 0.035) * 0.78 + Math.sin(TWO_PI * 70 * t) * env(t, 0.002, 0.09) * 0.55;
    }
  } else if (kind === 'typing' || kind === 'wood') {
    const decay = kind === 'typing' ? 65 : 22;
    const freq = kind === 'typing' ? 1600 : 520;
    for (let i = 0; i < total; i += 1) {
      const t = i / SFX_SAMPLE_RATE;
      out[i] = (Math.sin(TWO_PI * freq * t) * 0.65 + rng() * 0.35) * env(t, 0.002, 1 / decay) * 0.7;
    }
  }

  return fadeEdges(out, Math.min(96, Math.floor(total / 4)));
}

/** Encode stereo Float64Arrays into a standard 48 kHz 16-bit PCM WAV Buffer. */
export function encodeWav16Stereo(left, right, sampleRate = SFX_SAMPLE_RATE) {
  const frames = Math.min(left.length, right.length);
  const dataBytes = frames * 4;
  const buf = Buffer.allocUnsafe(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20);  // PCM format
  buf.writeUInt16LE(2, 22);  // stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28); // byteRate
  buf.writeUInt16LE(4, 32);  // blockAlign
  buf.writeUInt16LE(16, 34); // bitsPerSample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);

  let pos = 44;
  for (let i = 0; i < frames; i += 1) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    buf.writeInt16LE(Math.round(l * 32767), pos);
    buf.writeInt16LE(Math.round(r * 32767), pos + 2);
    pos += 4;
  }
  return buf;
}

/** Synthesize one standalone stereo `.wav` buffer for clip-mode placement. */
export function synthesizeSfxWav(kind, opts = {}) {
  const mono = synthesizeSfxMono(kind, opts);
  const gain = opts.gain !== undefined ? Math.min(2, Math.max(0.05, Number(opts.gain))) : 0.85;
  const scaled = new Float64Array(mono.length);
  let peak = 0;
  for (let i = 0; i < mono.length; i += 1) {
    scaled[i] = mono[i] * gain;
    peak = Math.max(peak, Math.abs(scaled[i]));
  }
  if (peak > 0.87) {
    const scale = 0.87 / peak;
    for (let i = 0; i < scaled.length; i += 1) scaled[i] *= scale;
  }
  return {
    wav: encodeWav16Stereo(scaled, scaled),
    duration: Number((mono.length / SFX_SAMPLE_RATE).toFixed(3)),
  };
}

/**
 * Greedy interval packing: assign cues onto the minimum number of non-overlapping
 * `<section>` audio tracks (respecting OpenFilm's strict non-overlap rule + 20 ms guard).
 */
export function packCuesToLanes(cues, gapSec = 0.02) {
  const sorted = [...cues]
    .map((cue, index) => {
      const meta = SFX_CATALOG[cue.kind] || { duration: 0.4 };
      const dur = Number.isFinite(Number(cue.duration)) ? Number(cue.duration) : meta.duration;
      return { ...cue, index, at: Math.max(0, Number(cue.at) || 0), duration: Math.max(0.02, dur) };
    })
    .sort((a, b) => a.at - b.at || a.index - b.index);

  const lanes = [];
  for (const item of sorted) {
    let placed = false;
    for (const lane of lanes) {
      if (item.at >= lane.end + gapSec) {
        lane.items.push(item);
        lane.end = item.at + item.duration;
        placed = true;
        break;
      }
    }
    if (!placed) {
      lanes.push({ end: item.at + item.duration, items: [item] });
    }
  }
  return lanes.map((lane, idx) => ({ lane: idx, items: lane.items }));
}

/**
 * Mix all cues into a single 48 kHz stereo stem WAV buffer with subtle panning on
 * dense `click`/`tick` cues and a `-1.2 dBFS` (`0.87`) peak ceiling.
 */
export function renderSfxStem(cues, totalSeconds, { gain = 0.65, ceiling = 0.87, seed = 410 } = {}) {
  const duration = Math.max(0.5, Math.min(600, Number(totalSeconds) || 10));
  const totalSamples = Math.ceil(duration * SFX_SAMPLE_RATE);
  const left = new Float64Array(totalSamples);
  const right = new Float64Array(totalSamples);
  const rng = createRng(seed);
  const cache = new Map();
  const duckPoints = [];

  for (const cue of cues) {
    const kind = cue?.kind;
    if (!SFX_CATALOG[kind]) continue;
    const at = Number(cue.at);
    if (!Number.isFinite(at) || at < 0 || at >= duration) continue;
    const cueGain = Number.isFinite(Number(cue.gain)) ? Math.max(0.05, Math.min(2, Number(cue.gain))) : 1;
    const pitch = Number.isFinite(Number(cue.pitch)) ? Number(cue.pitch) : undefined;
    const cacheKey = `${kind}|${pitch ?? ''}|${cue.duration ?? ''}`;
    let mono = cache.get(cacheKey);
    if (!mono || kind === 'click') {
      mono = synthesizeSfxMono(kind, {
        pitch,
        duration: cue.duration,
        seed: seed + Math.round(at * 1000),
      });
      if (kind !== 'click') cache.set(cacheKey, mono);
    }
    const start = Math.round(at * SFX_SAMPLE_RATE);
    const n = Math.min(mono.length, totalSamples - start);
    const pan = (kind === 'click' || kind === 'tick') ? rng() * 0.16 : 0;
    const gL = cueGain * gain * (1 - pan);
    const gR = cueGain * gain * (1 + pan);
    for (let i = 0; i < n; i += 1) {
      left[start + i] += mono[i] * gL;
      right[start + i] += mono[i] * gR;
    }
    if (kind === 'hit') duckPoints.push(Number(at.toFixed(3)));
  }

  let peakBefore = 0;
  for (let i = 0; i < totalSamples; i += 1) {
    peakBefore = Math.max(peakBefore, Math.abs(left[i]), Math.abs(right[i]));
  }
  if (peakBefore > ceiling) {
    const scale = ceiling / peakBefore;
    for (let i = 0; i < totalSamples; i += 1) {
      left[i] *= scale;
      right[i] *= scale;
    }
  }
  const peakAfter = Math.min(peakBefore, ceiling);
  const peakDb = peakAfter > 1e-6 ? Number((20 * Math.log10(peakAfter)).toFixed(2)) : -96;

  return {
    wav: encodeWav16Stereo(left, right),
    duration: Number((totalSamples / SFX_SAMPLE_RATE).toFixed(3)),
    peakDb,
    duckPoints,
  };
}
