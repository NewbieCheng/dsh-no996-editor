/**
 * Pure Node.js audio rhythm, onset, energy-curve and climax analyzer.
 *
 * Zero Python/librosa/numpy dependency: uses the bundled FFmpeg binary via
 * `src/asr/asr-audio.mjs` to extract mono 22050 Hz PCM, then runs a Radix-2
 * FFT, multi-band spectral flux, dynamic-programming beat tracking, and
 * sliding-window RMS energy segmentation to locate climaxes, drops and valleys.
 *
 * Output matches `window.RHYTHM` consumed by Vibe templates and `no996_rhythm`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { probeMedia, resolveFfmpeg, runFfmpeg } from '../asr/asr-audio.mjs';
import { parseWavHeader } from '../asr/asr-wav.mjs';

export const DEFAULT_SAMPLE_RATE = 22050;
export const MAX_ANALYSIS_SECONDS = 15 * 60;
const HOP = 512;
const N_FFT = 2048;

const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
const round = (value, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** In-place Radix-2 Cooley-Tukey FFT; `re.length` must be a power of 2. */
export function fftRadix2(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(angle);
    const wlenIm = Math.sin(angle);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j += 1) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nextRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextRe;
      }
    }
  }
}

function hannWindow(length) {
  const win = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (length - 1)));
  }
  return win;
}

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = Float32Array.from(values).sort();
  const idx = clamp(Math.floor((sorted.length - 1) * q), 0, sorted.length - 1);
  return sorted[idx];
}

function localMaxPercentile(values, halfWin, q = 0.9) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const start = Math.max(0, i - halfWin);
    const end = Math.min(values.length, i + halfWin + 1);
    const slice = values.subarray(start, end);
    out[i] = percentile(slice, q);
  }
  return out;
}

function pickPeaks(values, { minHeight = 0.55, minProminence = 0.2, minDistance = 3 } = {}) {
  const peaks = [];
  for (let i = 1; i + 1 < values.length; i += 1) {
    const v = values[i];
    if (v < minHeight || v < values[i - 1] || v <= values[i + 1]) continue;
    let leftMin = v;
    for (let k = Math.max(0, i - minDistance); k < i; k += 1) leftMin = Math.min(leftMin, values[k]);
    let rightMin = v;
    for (let k = i + 1; k <= Math.min(values.length - 1, i + minDistance); k += 1) rightMin = Math.min(rightMin, values[k]);
    const prominence = v - Math.max(leftMin, rightMin);
    if (prominence < minProminence) continue;
    if (peaks.length && i - peaks[peaks.length - 1] < minDistance) {
      if (v > values[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
    } else {
      peaks.push(i);
    }
  }
  return peaks;
}

/** Estimate BPM via autocorrelation on normalized onset envelope. */
function estimateTempo(envelope, frameRate) {
  const minLag = Math.max(1, Math.round((60 / 180) * frameRate));
  const maxLag = Math.min(envelope.length - 1, Math.round((60 / 60) * frameRate));
  if (maxLag <= minLag) return { bpm: 120, periodFrames: frameRate * 0.5 };
  let mean = 0;
  for (let i = 0; i < envelope.length; i += 1) mean += envelope[i];
  mean /= Math.max(1, envelope.length);

  let bestLag = Math.round(frameRate * 0.5);
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    const count = envelope.length - lag;
    for (let i = 0; i < count; i += 1) {
      sum += (envelope[i] - mean) * (envelope[i + lag] - mean);
    }
    const bpm = (60 * frameRate) / lag;
    // Mild perceptual prior centering around 115 BPM to reduce half/double-time errors.
    const prior = Math.exp(-0.5 * ((Math.log2(bpm / 115)) / 0.55) ** 2);
    const score = (sum / Math.max(1, count)) * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return { bpm: round((60 * frameRate) / bestLag, 1), periodFrames: bestLag };
}

/** Ellis-style DP beat tracker on onset strength envelope. */
function trackBeats(envelope, rms, silenceGate, periodFrames, frameRate) {
  const n = envelope.length;
  if (n === 0 || periodFrames <= 1) return { beats: [], beatStrength: [] };
  const tightness = 100;
  const maxEnv = Math.max(1e-6, percentile(envelope, 0.99));
  const localScore = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    localScore[i] = rms[i] >= silenceGate ? envelope[i] / maxEnv : 0;
  }

  const cumScore = new Float32Array(n);
  const backlink = new Int32Array(n).fill(-1);
  const txCost = new Float32Array(Math.ceil(periodFrames * 2) + 2);
  for (let d = 1; d < txCost.length; d += 1) {
    const ratio = Math.log(d / periodFrames);
    txCost[d] = -tightness * ratio * ratio;
  }

  const minPrev = Math.max(1, Math.round(periodFrames * 0.5));
  const maxPrev = Math.min(txCost.length - 1, Math.round(periodFrames * 2));
  for (let i = 0; i < n; i += 1) {
    let best = localScore[i];
    let bestPrev = -1;
    const start = Math.max(0, i - maxPrev);
    const end = i - minPrev;
    for (let j = start; j <= end; j += 1) {
      const candidate = cumScore[j] + txCost[i - j] + localScore[i];
      if (candidate > best) {
        best = candidate;
        bestPrev = j;
      }
    }
    cumScore[i] = best;
    backlink[i] = bestPrev;
  }

  // Pick strongest terminal beat within the last 1.5 beat periods.
  let tailBest = n - 1;
  const tailStart = Math.max(0, n - Math.round(periodFrames * 1.5));
  for (let i = tailStart; i < n; i += 1) {
    if (cumScore[i] > cumScore[tailBest]) tailBest = i;
  }

  const frames = [];
  for (let cur = tailBest; cur >= 0; cur = backlink[cur]) {
    if (rms[cur] >= silenceGate) frames.push(cur);
  }
  frames.reverse();

  // Snap each tracked beat within +-3 frames to the strongest local transient.
  const beats = [];
  const beatStrength = [];
  for (const frame of frames) {
    let bestFrame = frame;
    const lo = Math.max(0, frame - 3);
    const hi = Math.min(n - 1, frame + 3);
    for (let k = lo; k <= hi; k += 1) {
      if (localScore[k] > localScore[bestFrame]) bestFrame = k;
    }
    const timeMs = Math.round((bestFrame * HOP * 1000) / (frameRate * HOP));
    if (beats.length && Math.abs(timeMs - beats[beats.length - 1]) < 120) continue;
    beats.push(timeMs);
    beatStrength.push(round(clamp(localScore[bestFrame], 0, 1), 4));
  }
  return { beats, beatStrength };
}

/**
 * Segment energy curve into sections, climaxes, drops and quiet valleys.
 * Pure function of per-frame RMS values.
 */
function analyzeEnergyStructure(rms, frameRate, durationSec) {
  const winFrames = Math.max(1, Math.round(frameRate * 2.0));
  const stepFrames = Math.max(1, Math.round(frameRate * 0.5));
  const energyCurve = [];
  for (let i = 0; i < rms.length; i += stepFrames) {
    const end = Math.min(rms.length, i + winFrames);
    let sumSq = 0;
    for (let k = i; k < end; k += 1) sumSq += rms[k] * rms[k];
    const value = Math.sqrt(sumSq / Math.max(1, end - i));
    energyCurve.push({ t: round(i / frameRate, 2), e: value });
  }
  const peakEnergy = Math.max(1e-6, ...energyCurve.map(p => p.e));
  for (const point of energyCurve) point.e = round(point.e / peakEnergy, 4);

  const nonZero = energyCurve.map(p => p.e).filter(v => v > 0.02);
  const median = nonZero.length ? percentile(Float32Array.from(nonZero), 0.5) : 0.4;
  const climaxThreshold = Math.max(0.62, median * 1.32);
  const valleyThreshold = Math.min(0.32, median * 0.65);

  const climaxes = [];
  const valleys = [];
  let activeClimax = null;
  let activeValley = null;

  for (let i = 0; i < energyCurve.length; i += 1) {
    const { t, e } = energyCurve[i];
    if (e >= climaxThreshold) {
      if (!activeClimax) activeClimax = { start: t, end: t, peakAt: t, peak: e };
      else {
        activeClimax.end = t;
        if (e > activeClimax.peak) { activeClimax.peak = e; activeClimax.peakAt = t; }
      }
    } else if (activeClimax) {
      if (activeClimax.end - activeClimax.start >= 2.0) climaxes.push(activeClimax);
      activeClimax = null;
    }

    if (e <= valleyThreshold && e > 0.02) {
      if (!activeValley) activeValley = { start: t, end: t, min: e };
      else { activeValley.end = t; activeValley.min = Math.min(activeValley.min, e); }
    } else if (activeValley) {
      if (activeValley.end - activeValley.start >= 2.0) valleys.push(activeValley);
      activeValley = null;
    }
  }
  if (activeClimax && activeClimax.end - activeClimax.start >= 2.0) climaxes.push(activeClimax);
  if (activeValley && activeValley.end - activeValley.start >= 2.0) valleys.push(activeValley);

  // Drops: sharp 1-second energy jumps >= +6 dB (amplitude ratio >= 2.0) into active energy.
  const drops = [];
  for (let i = 2; i < energyCurve.length; i += 1) {
    const prev = Math.max(0.03, energyCurve[i - 2].e);
    const cur = energyCurve[i].e;
    if (cur >= 0.55 && cur / prev >= 2.0) {
      const t = energyCurve[i].t;
      if (!drops.length || t - drops[drops.length - 1].at >= 3.0) {
        drops.push({ at: t, energy: cur, ratio: round(cur / prev, 2) });
      }
    }
  }

  const sections = [];
  for (const c of climaxes) sections.push({ kind: 'climax', start: c.start, end: round(Math.min(durationSec, c.end + 0.5), 2), peakAt: c.peakAt });
  for (const v of valleys) sections.push({ kind: 'valley', start: v.start, end: round(Math.min(durationSec, v.end + 0.5), 2) });
  sections.sort((a, b) => a.start - b.start);

  return { energyCurve, climaxes, drops, valleys, sections };
}

/**
 * Analyze mono audio samples in memory (pure, deterministic, testable without FFmpeg).
 *
 * @param {Float32Array} samples - mono PCM normalized to [-1, 1]
 * @param {number} [sampleRate=22050]
 * @returns {object}
 */
export function analyzeAudioSamples(samples, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw new Error('音频采样为空，无法分析节奏。');
  }
  const durationSec = round(samples.length / sampleRate, 3);
  const frameCount = Math.max(0, Math.floor((samples.length - N_FFT) / HOP) + 1);
  const frameRate = sampleRate / HOP;
  if (frameCount < 4) {
    return {
      version: 1,
      durationSec,
      durationMs: Math.round(durationSec * 1000),
      bpm: 0,
      beats: [],
      beatStrength: [],
      onsets: [],
      tonal: [],
      energyCurve: [],
      climaxes: [],
      drops: [],
      valleys: [],
      sections: [],
    };
  }

  const win = hannWindow(N_FFT);
  const halfBins = N_FFT / 2 + 1;
  const binHz = sampleRate / N_FFT;
  const lowEnd = Math.ceil(250 / binHz);
  const midEnd = Math.ceil(1800 / binHz);
  const highEnd = Math.min(halfBins - 1, Math.floor(10000 / binHz));
  const lowStart = Math.max(1, Math.floor(40 / binHz));

  const rms = new Float32Array(frameCount);
  const fluxAll = new Float32Array(frameCount);
  const fluxLow = new Float32Array(frameCount);
  const fluxTonal = new Float32Array(frameCount);
  const prevMag = new Float32Array(halfBins);
  const re = new Float32Array(N_FFT);
  const im = new Float32Array(N_FFT);

  for (let f = 0; f < frameCount; f += 1) {
    const offset = f * HOP;
    let sumSq = 0;
    for (let i = 0; i < N_FFT; i += 1) {
      const s = samples[offset + i];
      sumSq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sumSq / N_FFT);
    fftRadix2(re, im);

    let fAll = 0;
    let fLow = 0;
    let fTone = 0;
    for (let b = lowStart; b <= highEnd; b += 1) {
      const mag = Math.hypot(re[b], im[b]);
      const diff = mag - prevMag[b];
      if (diff > 0) {
        const logDiff = Math.log1p(diff * 8);
        fAll += logDiff;
        if (b < lowEnd) fLow += logDiff;
        if (b >= lowEnd && b < midEnd) fTone += logDiff;
      }
      prevMag[b] = mag;
    }
    fluxAll[f] = fAll;
    fluxLow[f] = fLow;
    fluxTonal[f] = fTone;
  }

  const loudness = percentile(rms, 0.95);
  if (loudness <= 1e-5) {
    return {
      version: 1,
      durationSec,
      durationMs: Math.round(durationSec * 1000),
      bpm: 0,
      beats: [],
      beatStrength: [],
      onsets: [],
      tonal: [],
      energyCurve: [],
      climaxes: [],
      drops: [],
      valleys: [],
      sections: [],
    };
  }
  const silenceGate = Math.max(loudness * 0.025, 1e-5);
  const halfSec = Math.max(4, Math.round(frameRate));

  const scaleAll = localMaxPercentile(fluxAll, halfSec, 0.9);
  const floorAll = Math.max(percentile(fluxAll, 0.9) * 0.15, 0.05);
  const normAll = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    normAll[i] = rms[i] >= silenceGate ? fluxAll[i] / Math.max(scaleAll[i], floorAll) : 0;
  }

  const scaleTone = localMaxPercentile(fluxTonal, halfSec, 0.9);
  const floorTone = Math.max(percentile(fluxTonal, 0.9) * 0.15, 0.05);
  const normTone = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    normTone[i] = rms[i] >= silenceGate ? fluxTonal[i] / Math.max(scaleTone[i], floorTone) : 0;
  }

  const beatEnv = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    beatEnv[i] = fluxLow[i] * 0.65 + fluxAll[i] * 0.35;
  }

  const { bpm, periodFrames } = estimateTempo(beatEnv, frameRate);
  const { beats, beatStrength } = trackBeats(beatEnv, rms, silenceGate, periodFrames, frameRate);

  const onsetFrames = pickPeaks(normAll, { minHeight: 0.55, minProminence: 0.22, minDistance: 3 });
  const onsets = [];
  for (const frame of onsetFrames) {
    const timeMs = Math.round((frame * HOP * 1000) / sampleRate);
    if (timeMs < 30 || timeMs >= Math.round(durationSec * 1000) - 50) continue;
    const val = normAll[frame];
    const strength = round(val / (val + 0.7), 4);
    onsets.push([timeMs, strength]);
  }

  const tonalFrames = pickPeaks(normTone, { minHeight: 0.58, minProminence: 0.24, minDistance: 3 });
  const tonal = [];
  for (const frame of tonalFrames) {
    const timeMs = Math.round((frame * HOP * 1000) / sampleRate);
    if (timeMs < 50 || timeMs >= Math.round(durationSec * 1000) - 50) continue;
    const val = normTone[frame];
    const strength = round(val / (val + 0.7), 4);
    tonal.push([timeMs, strength]);
  }

  const energy = analyzeEnergyStructure(rms, frameRate, durationSec);
  return {
    version: 1,
    durationSec,
    durationMs: Math.round(durationSec * 1000),
    bpm,
    beats,
    beatStrength,
    onsets,
    tonal,
    energyCurve: energy.energyCurve,
    climaxes: energy.climaxes,
    drops: energy.drops,
    valleys: energy.valleys,
    sections: energy.sections,
  };
}

/** Plan scene cut candidates & local accent events from a measured rhythm payload. */
export function planRhythmEvents(analysis, { beatsPerScene = 4, minOnsetStrength = 0.52 } = {}) {
  const beats = Array.isArray(analysis?.beats) ? analysis.beats : [];
  const strengths = Array.isArray(analysis?.beatStrength) ? analysis.beatStrength : [];
  const onsets = Array.isArray(analysis?.onsets) ? analysis.onsets : [];
  const step = Math.max(1, Math.trunc(beatsPerScene) || 4);

  const sceneEvents = [];
  for (let i = 0; i < beats.length; i += step) {
    sceneEvents.push({
      beatIndex: i,
      timeMs: beats[i],
      timeSec: round(beats[i] / 1000, 3),
      strength: strengths[i] ?? 1,
    });
  }

  const localEvents = [];
  for (const [timeMs, strength] of onsets) {
    if (strength < minOnsetStrength) continue;
    if (sceneEvents.some(e => Math.abs(e.timeMs - timeMs) < 60)) continue;
    localEvents.push({
      timeMs,
      timeSec: round(timeMs / 1000, 3),
      strength,
    });
  }

  return { sceneEvents, localEvents };
}

/** Decode any audio/video file to mono 22050 Hz Float32Array via FFmpeg. */
export async function extractMonoFloat32(sourcePath, {
  sampleRate = DEFAULT_SAMPLE_RATE,
  signal,
  resolve = resolveFfmpeg,
  run = runFfmpeg,
} = {}) {
  const ffmpeg = await resolve();
  const workDir = await mkdtemp(join(tmpdir(), 'no996-rhythm-'));
  try {
    const probe = await probeMedia(ffmpeg, sourcePath, { workDir, signal, run });
    if (probe.durationSec !== null && probe.durationSec > MAX_ANALYSIS_SECONDS) {
      throw new Error(`音频时长 ${Math.round(probe.durationSec)} 秒，超过节奏分析上限 ${MAX_ANALYSIS_SECONDS} 秒。`);
    }
    const wavPath = join(workDir, 'mono.wav');
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', sourcePath,
      '-vn', '-map', '0:a:0',
      '-ac', '1', '-ar', String(sampleRate),
      '-c:a', 'pcm_s16le',
      '-f', 'wav', wavPath,
    ];
    const { code, stderr } = await run(ffmpeg, args, { workDir, timeoutMs: 120_000, signal });
    if (code !== 0) {
      throw new Error(`FFmpeg 解码音频失败：${String(stderr || `exit ${code}`).slice(0, 180)}`);
    }
    const info = await stat(wavPath);
    if (!info.isFile() || info.size < 44) throw new Error('解码后的音频为空。');
    const handle = await open(wavPath, 'r');
    try {
      const header = Buffer.alloc(Math.min(4096, info.size));
      await handle.read(header, 0, header.length, 0);
      const parsed = parseWavHeader(header, info.size);
      const bytes = await readFile(wavPath);
      const pcm = bytes.subarray(parsed.dataOffset, parsed.dataOffset + parsed.dataBytes);
      const count = Math.floor(pcm.byteLength / 2);
      const out = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        out[i] = pcm.readInt16LE(i * 2) / 32768;
      }
      return { samples: out, sampleRate: parsed.sampleRate || sampleRate };
    } finally {
      await handle.close().catch(() => {});
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** SHA-256 fingerprint of a file on disk for rhythm cache deduplication. */
export async function hashFileSha256(filePath) {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

export function readCachedRhythm(cachePath, expectedSha256) {
  try {
    if (!existsSync(cachePath)) return null;
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (parsed?.sha256 && parsed.sha256 === expectedSha256 && Array.isArray(parsed?.analysis?.beats)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

/**
 * Emit static `window.RHYTHM = ...;` script so OpenFilm pages read beats/onsets/climaxes
 * synchronously during `ready` without `fetch` (works under any host or `file://`).
 */
export function writeRhythmDataJs(filePath, analysis, meta = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const payload = {
    version: analysis.version ?? 1,
    source: meta.source || '',
    sha256: meta.sha256 || '',
    durationSec: analysis.durationSec,
    durationMs: analysis.durationMs,
    bpm: analysis.bpm,
    beats: analysis.beats,
    beatStrength: analysis.beatStrength,
    onsets: analysis.onsets,
    tonal: analysis.tonal,
    climaxes: analysis.climaxes,
    drops: analysis.drops,
    valleys: analysis.valleys,
    sections: analysis.sections,
  };
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `/* Generated by no996_rhythm. Static data for window.film pages (no fetch). */\nwindow.RHYTHM = ${JSON.stringify(payload)};\n`, 'utf8');
  renameSync(tmp, filePath);
  return filePath;
}
