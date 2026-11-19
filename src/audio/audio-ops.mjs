/**
 * Pure Node.js + bundled FFmpeg audio operations:
 *   1. Extract audio from project video + detect silence/speech segments & loudness;
 *   2. Build smooth FFmpeg volume ducking expressions for BGM under speech/dialogue.
 */
import { mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { probeMedia, resolveFfmpeg, runFfmpeg } from '../asr/asr-audio.mjs';

const MIN_SPEECH_GAP_SEC = 0.35;

/** Parse FFmpeg `silencedetect` stderr lines into silence intervals `[{ start, end, duration }]`. */
export function parseSilenceDetect(stderr, totalDuration = null) {
  const text = String(stderr || '');
  const silences = [];
  let pendingStart = null;
  for (const line of text.split(/\r?\n/)) {
    const startMatch = /silence_start:\s*([-+]?\d+(?:\.\d+)?)/.exec(line);
    if (startMatch) {
      const value = Number(startMatch[1]);
      if (Number.isFinite(value)) pendingStart = Math.max(0, value);
      continue;
    }
    const endMatch = /silence_end:\s*([-+]?\d+(?:\.\d+)?)(?:\s*\|\s*silence_duration:\s*([-+]?\d+(?:\.\d+)?))?/.exec(line);
    if (endMatch) {
      const end = Number(endMatch[1]);
      const start = pendingStart !== null ? pendingStart : Math.max(0, end - (Number(endMatch[2]) || 0));
      if (Number.isFinite(end) && end > start) {
        silences.push({
          start: Number(start.toFixed(3)),
          end: Number(end.toFixed(3)),
          duration: Number((end - start).toFixed(3)),
        });
      }
      pendingStart = null;
    }
  }
  if (pendingStart !== null && Number.isFinite(totalDuration) && totalDuration > pendingStart) {
    silences.push({
      start: Number(pendingStart.toFixed(3)),
      end: Number(totalDuration.toFixed(3)),
      duration: Number((totalDuration - pendingStart).toFixed(3)),
    });
  }
  return silences;
}

/** Parse FFmpeg `volumedetect` mean/max dB values from stderr. */
export function parseVolumeDetect(stderr) {
  const text = String(stderr || '');
  const meanMatch = /mean_volume:\s*([-+]?\d+(?:\.\d+)?)\s*dB/.exec(text);
  const maxMatch = /max_volume:\s*([-+]?\d+(?:\.\d+)?)\s*dB/.exec(text);
  return {
    meanDb: meanMatch ? Number(meanMatch[1]) : null,
    maxDb: maxMatch ? Number(maxMatch[1]) : null,
  };
}

/** Invert silence intervals into active speech/audio segments, merging tiny gaps. */
export function deriveActiveSegments(silences, totalDuration, minGap = MIN_SPEECH_GAP_SEC) {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) return [];
  const mergedSilence = [];
  const sorted = [...(silences || [])]
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  for (const item of sorted) {
    const start = Math.max(0, item.start);
    const end = Math.min(totalDuration, item.end);
    if (end - start < minGap) continue;
    if (!mergedSilence.length || start > mergedSilence[mergedSilence.length - 1].end + 0.05) {
      mergedSilence.push({ start, end });
    } else {
      mergedSilence[mergedSilence.length - 1].end = Math.max(mergedSilence[mergedSilence.length - 1].end, end);
    }
  }
  const active = [];
  let cursor = 0;
  for (const s of mergedSilence) {
    if (s.start > cursor + 0.08) {
      active.push({ start: Number(cursor.toFixed(3)), end: Number(s.start.toFixed(3)) });
    }
    cursor = Math.max(cursor, s.end);
  }
  if (totalDuration > cursor + 0.08) {
    active.push({ start: Number(cursor.toFixed(3)), end: Number(totalDuration.toFixed(3)) });
  }
  return active;
}

/**
 * Merge overlapping or closely spaced speech ranges (`<= mergeGapSec`) so ducking
 * does not pump up and down between rapid phrases.
 */
export function mergeSpeechRanges(ranges, mergeGapSec = 0.45) {
  const clean = (Array.isArray(ranges) ? ranges : [])
    .map(r => ({ start: Number(r?.start), end: Number(r?.end) }))
    .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start && r.start >= 0)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const item of clean) {
    if (!out.length || item.start > out[out.length - 1].end + mergeGapSec) {
      out.push({ start: Number(item.start.toFixed(3)), end: Number(item.end.toFixed(3)) });
    } else {
      out[out.length - 1].end = Number(Math.max(out[out.length - 1].end, item.end).toFixed(3));
    }
  }
  return out;
}

/**
 * Build a smooth FFmpeg `volume` expression with `rampSec` attack/release around
 * each speech interval, suitable for `eval=frame`.
 */
export function buildDuckingVolumeExpr(ranges, {
  normalGain = 0.48,
  duckDb = -12,
  rampSec = 0.22,
} = {}) {
  const base = Math.max(0.05, Math.min(1.5, Number(normalGain) || 0.48));
  const db = Math.max(-30, Math.min(-2, Number(duckDb) || -12));
  const duckRatio = Math.pow(10, db / 20);
  const low = Number((base * duckRatio).toFixed(4));
  const high = Number(base.toFixed(4));
  const merged = mergeSpeechRanges(ranges);
  if (merged.length === 0) return String(high);

  const ramp = Math.max(0.05, Math.min(0.8, Number(rampSec) || 0.22));
  const terms = merged.map(({ start, end }) => {
    const a0 = Math.max(0, start - ramp).toFixed(3);
    const a1 = start.toFixed(3);
    const b0 = end.toFixed(3);
    const b1 = (end + ramp).toFixed(3);
    const attack = a1 === a0 ? `gte(t,${a1})` : `if(between(t,${a0},${a1}),(t-${a0})/${(start - Number(a0)).toFixed(3)},0)`;
    const release = `if(between(t,${b0},${b1}),(${b1}-t)/${ramp.toFixed(3)},0)`;
    return `max(between(t,${a1},${b0}),max(${attack},${release}))`;
  });
  const duckMask = terms.length === 1
    ? terms[0]
    : terms.reduce((acc, term) => `max(${acc},${term})`);
  const delta = Number((high - low).toFixed(4));
  return `${high}-${delta}*min(1,${duckMask})`;
}

/** Extract 48kHz stereo WAV/MP3 from a video or audio file + return silence/speech breakdown. */
export async function extractProjectAudio({
  sourceFull,
  targetFull,
  format = 'wav',
  silenceDb = -32,
  minSilenceSec = 0.35,
  resolve = resolveFfmpeg,
  run = runFfmpeg,
  signal,
} = {}) {
  const ffmpeg = await resolve();
  mkdirSync(dirname(targetFull), { recursive: true });
  const probe = await probeMedia(ffmpeg, sourceFull, { workDir: dirname(targetFull), run, signal });
  if (!probe.hasAudio) {
    throw new Error('该文件没有音频轨，无法提取声音。');
  }
  const tmpOut = `${targetFull}.${process.pid}.part.${format === 'mp3' ? 'mp3' : 'wav'}`;
  const codecArgs = format === 'mp3'
    ? ['-c:a', 'libmp3lame', '-b:a', '192k']
    : ['-c:a', 'pcm_s16le'];
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'info', '-y',
    '-i', sourceFull,
    '-vn', '-map', '0:a:0',
    '-ar', '48000', '-ac', '2',
    '-af', `silencedetect=noise=${Number(silenceDb)}dB:d=${Number(minSilenceSec)},volumedetect`,
    ...codecArgs,
    tmpOut,
  ];
  const res = await run(ffmpeg, args, { workDir: dirname(targetFull), timeoutMs: 120_000, signal });
  if (res.code !== 0) {
    throw new Error(`提取音频失败：${String(res.stderr || `exit ${res.code}`).slice(0, 200)}`);
  }
  const info = statSync(tmpOut);
  if (!info.isFile() || info.size < 44) throw new Error('提取出的音频文件为空。');
  renameSync(tmpOut, targetFull);

  const durationSec = probe.durationSec ?? 0;
  const silences = parseSilenceDetect(res.stderr, durationSec);
  const activeSegments = deriveActiveSegments(silences, durationSec, minSilenceSec);
  const volume = parseVolumeDetect(res.stderr);
  return {
    durationSec: Number(durationSec.toFixed(3)),
    bytes: info.size,
    silences,
    activeSegments,
    volume,
  };
}

/** Render a ducked BGM track (48kHz stereo WAV) that ducks under speech/dialogue segments. */
export async function renderDuckedBgm({
  bgmFull,
  targetFull,
  speechRanges = [],
  normalGain = 0.48,
  duckDb = -12,
  duration = null,
  fadeOut = 1.2,
  resolve = resolveFfmpeg,
  run = runFfmpeg,
  signal,
} = {}) {
  const ffmpeg = await resolve();
  mkdirSync(dirname(targetFull), { recursive: true });
  const probe = await probeMedia(ffmpeg, bgmFull, { workDir: dirname(targetFull), run, signal });
  if (!probe.hasAudio) throw new Error('输入 BGM 文件没有音频轨。');

  const maxDur = probe.durationSec || 0;
  const targetDur = Number.isFinite(duration) && duration > 0.5
    ? Math.min(Number(duration), maxDur || Number(duration))
    : maxDur;

  const volExpr = buildDuckingVolumeExpr(speechRanges, { normalGain, duckDb });
  const filters = [`volume='${volExpr}':eval=frame`];
  if (targetDur > 1.5 && fadeOut > 0) {
    const fade = Math.min(Number(fadeOut), targetDur * 0.35);
    filters.push(`afade=t=out:st=${Math.max(0, targetDur - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
  }

  const tmpOut = `${targetFull}.${process.pid}.part.wav`;
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-i', bgmFull,
    ...(Number.isFinite(duration) && duration > 0.5 ? ['-t', String(targetDur.toFixed(3))] : []),
    '-vn', '-map', '0:a:0',
    '-af', filters.join(','),
    '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le',
    tmpOut,
  ];
  const res = await run(ffmpeg, args, { workDir: dirname(targetFull), timeoutMs: 120_000, signal });
  if (res.code !== 0) {
    throw new Error(`BGM 人声闪避混音失败：${String(res.stderr || `exit ${res.code}`).slice(0, 200)}`);
  }
  const info = statSync(tmpOut);
  if (!info.isFile() || info.size < 44) throw new Error('生成的闪避音频为空。');
  renameSync(tmpOut, targetFull);
  return {
    durationSec: Number(targetDur.toFixed(3)),
    bytes: info.size,
    mergedRanges: mergeSpeechRanges(speechRanges),
  };
}
