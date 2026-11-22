/**
 * The transcription service: one queue, one model, one cache.
 *
 * Three decisions here exist because of how this runs on a person's own computer.
 *
 *  1. **Single flight, single queue.** The model is 240 MB and a decode is CPU
 *     work; running two transcripts at once halves the speed of both and doubles
 *     the memory. Everything goes through one chain, so a second request waits
 *     instead of competing.
 *  2. **Install is started, not awaited.** A first run on a fresh machine has no
 *     weights. Blocking a tool call for several minutes looks like a hang, so the
 *     download starts in the background and the caller is told, in words it can act
 *     on, that it is running and where to look. `setup` and the first `from` both
 *     trigger it; `status` reports real bytes on disk.
 *  3. **The cache key is the file, not the path.** A copied or renamed video should
 *     hit the same cached transcript; an edited one must not. Size, mtime and both
 *     ends of the file are hashed — hashing 500 MB on every call would cost more
 *     than a few seconds of decode.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createMediaEdge } from './asr-media.mjs';
import { createSilenceSegmenter } from './asr-silence.mjs';
import { createSenseVoiceRecognizer, loadSherpa } from './asr-sensevoice.mjs';
import { modelState, ensureModels, senseVoiceDir, SENSE_VOICE } from './asr-models.mjs';
import { createTranscribePipeline } from './asr-pipeline.mjs';
import { parseWavHeader } from './asr-wav.mjs';

export const CACHE_VERSION = 2;
export const RUNNER_VERSION = 'sensevoice-small-int8@1';
const HEAD_BYTES = 256 * 1024;
const MAX_DICTATION_BYTES = 16 * 1024 * 1024;
const MAX_DICTATION_SEC = 120;

const fail = (message, code) => Object.assign(new Error(message), { code });

/** Size, mtime and both ends: cheap to compute, and it changes when the media does. */
export async function fingerprint(path) {
  const info = await stat(path);
  if (!info.isFile()) throw fail('不是一个文件：' + path, 'NOT_A_FILE');
  const span = Math.min(HEAD_BYTES, info.size);
  const head = Buffer.alloc(span);
  const tail = Buffer.alloc(span);
  const handle = await open(path, 'r');
  try {
    if (span > 0) {
      await handle.read(head, 0, span, 0);
      await handle.read(tail, 0, span, Math.max(0, info.size - span));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  const hash = createHash('sha256');
  hash.update(String(info.size)).update(String(Math.round(info.mtimeMs)));
  hash.update(head).update(tail);
  return { key: hash.digest('hex').slice(0, 20), bytes: info.size, mtimeMs: Math.round(info.mtimeMs) };
}

export function createTranscribeService({
  env = process.env,
  logger = null,
  fetchImpl = globalThis.fetch,
  media = null,
  recognizerFactory = null,
  segmenterFactory = null,
  pipelineFactory = null,
  now = Date.now,
} = {}) {
  let chain = Promise.resolve();
  let install = null;
  let installAbort = null;
  let recognizer = null;
  let recognizerLang = null;
  let busyJobs = 0;
  // What the last install attempt is doing, for the wizard: "connecting" is a
  // different user experience from "downloading", and a failure names its source.
  let installState = { phase: 'idle', source: '', file: '', seen: 0, total: 0, speed: 0, error: '', startedAt: 0 };

  const note = (event, detail) => {
    try { logger?.info?.(event, detail); } catch { /* logging must never fail a transcript */ }
  };

  /** Serialise every job: one model, one CPU, one queue. */
  const enqueue = task => {
    const wrapped = async () => {
      busyJobs += 1;
      try { return await task(); } finally { busyJobs -= 1; }
    };
    const started = chain.then(wrapped, wrapped);
    chain = started.then(() => undefined, () => undefined);
    return started;
  };

  const makeRecognizer = (lang) => {
    if (recognizer && recognizerLang === lang) return recognizer;
    if (typeof recognizerFactory === 'function') {
      recognizer = recognizerFactory({ dir: senseVoiceDir({ env }), lang });
      recognizerLang = lang;
      return recognizer;
    }
    const dir = senseVoiceDir({ env });
    recognizer = createSenseVoiceRecognizer({
      model: join(dir, 'model.int8.onnx'),
      tokens: join(dir, 'tokens.txt'),
      language: lang,
    });
    recognizerLang = lang;
    return recognizer;
  };

  /** Start (or join) the one download in flight. Never awaited by the caller. */
  function startInstall() {
    if (!install) {
      const startedAt = now();
      const controller = new AbortController();
      installAbort = controller;
      installState = { phase: 'connecting', source: '', file: '', seen: 0, total: 0, speed: 0, error: '', startedAt };
      let lastAt = startedAt;
      let lastSeen = 0;
      install = ensureModels({
        env,
        fetchImpl,
        signal: controller.signal,
        onEvent: event => {
          if (!event) return;
          if (event.phase === 'downloading') {
            const at = now();
            const seconds = (at - lastAt) / 1000;
            if (seconds >= 0.4) {
              installState.speed = Math.max(0, (event.seen - lastSeen) / seconds);
              lastAt = at;
              lastSeen = event.seen;
            }
          }
          installState = {
            ...installState,
            phase: event.phase ?? installState.phase,
            source: event.source ?? installState.source,
            file: event.file ?? installState.file,
            seen: event.seen ?? installState.seen,
            total: event.total ?? installState.total,
          };
        },
      })
        .then(state => { note('asr-install-done', { ready: state.ready }); installState = { ...installState, phase: 'done' }; return state; })
        .catch(error => {
          const cancelled = controller.signal.aborted || error?.code === 'ABORTED';
          note(cancelled ? 'asr-install-cancelled' : 'asr-install-failed', { code: error?.code ?? 'UNKNOWN' });
          installState = {
            ...installState,
            phase: cancelled ? 'idle' : 'failed',
            error: cancelled ? '' : String(error?.message || error).slice(0, 300),
          };
          throw error;
        })
        .finally(() => {
          install = null;
          if (installAbort === controller) installAbort = null;
        });
      // Nobody is awaiting this promise at the moment it is created: swallow the
      // rejection here so a failed download cannot surface as an unhandled one.
      install.catch(() => undefined);
      note('asr-install-started', { bytes: SENSE_VOICE.bytes, dir: senseVoiceDir({ env }) });
    }
    return install;
  }

  async function cancelInstall() {
    if (!installAbort) return status();
    installAbort.abort(Object.assign(new Error('已取消'), { code: 'ABORTED' }));
    try { await install; } catch { /* expected abort */ }
    return status();
  }

  async function bytesOnDisk(dir) {
    let total = 0;
    for (const file of SENSE_VOICE.files) {
      for (const name of [file.name, file.name + '.part']) {
        try { total += (await stat(join(dir, name))).size; } catch { /* absent */ }
      }
    }
    return total;
  }

  async function status() {
    const state = await modelState({ env });
    let engine = 'ready';
    try { loadSherpa(); } catch (error) { engine = error?.code ?? 'MISSING'; }
    const bytes = await bytesOnDisk(state.dir);
    return {
      ...state,
      engine,
      installing: install !== null,
      bytesOnDisk: bytes,
      progress: SENSE_VOICE.bytes > 0 ? Math.min(1, Math.round((bytes / SENSE_VOICE.bytes) * 1000) / 1000) : null,
      phase: installState.phase,
      source: installState.source,
      speed: installState.speed,
      error: installState.error,
    };
  }

  async function transcribe({ source, lang = 'auto', cacheDir = null, signal, onProgress = () => {}, prepare = true } = {}) {
    if (typeof source !== 'string' || source.length === 0) throw fail('需要一个音频或视频文件路径', 'NO_SOURCE');
    const state = await modelState({ env });
    if (!state.ready) {
      if (prepare) startInstall();
      const started = install !== null;
      throw fail(
        '本地语音模型还没准备好（' + SENSE_VOICE.label + '，约 ' + Math.round(SENSE_VOICE.bytes / 1024 / 1024) + ' MB）。'
          + (started ? '已经自动开始下载，完成后再次调用即可。' : '用 setup 开始下载。')
          + ' 下载目录：' + state.dir,
        'MODEL_NOT_READY',
      );
    }

    return enqueue(async () => {
      const print = await fingerprint(source).catch(error => {
        if (error?.code === 'ENOENT') throw fail('找不到这个文件：' + source, 'NOT_FOUND');
        throw error;
      });
      const cacheKey = `${print.key}.${lang}.${RUNNER_VERSION.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const cachePath = cacheDir ? join(cacheDir, `${cacheKey}.json`) : null;
      const legacyCachePath = cacheDir && lang === 'auto' ? join(cacheDir, `${print.key}.json`) : null;
      for (const candidatePath of [cachePath, legacyCachePath].filter(Boolean)) {
        try {
          const cached = JSON.parse(await readFile(candidatePath, 'utf8'));
          const vOk = cached?.v === CACHE_VERSION || (cached?.v === 1 && candidatePath === legacyCachePath);
          const runnerOk = cached?.v === 1 || cached?.runnerVersion === RUNNER_VERSION;
          const langOk = cached?.v === 1 || cached?.lang === lang;
          if (vOk && runnerOk && langOk && Array.isArray(cached.segments) && typeof cached.text === 'string') {
            note('asr-cache-hit', { key: print.key, lang });
            return { ...cached, cached: true };
          }
        } catch { /* a corrupt cache entry is a miss, not a failure */ }
      }

      const workDir = await mkdtemp(join(tmpdir(), 'dsh-transcribe-'));
      const modelLoadStarted = now();
      try {
        const edge = media ?? createMediaEdge({ env });
        const active = makeRecognizer(lang);
        let modelLoadMs = null;
        try {
          active.warm?.();
          modelLoadMs = now() - modelLoadStarted;
        } catch (error) {
          throw fail(
            '语音识别引擎没有加载成功：' + String(error?.message || error).slice(0, 200),
            error?.code ?? 'ENGINE_FAILED',
          );
        }
        const pipeline = (pipelineFactory ?? createTranscribePipeline)({
          media: edge,
          segmenter: (segmenterFactory ?? createSilenceSegmenter)(),
          recognizer: active,
        });
        const result = await pipeline.run({ source, workDir, signal, onProgress });
        const record = {
          v: CACHE_VERSION,
          runnerVersion: RUNNER_VERSION,
          lang,
          model: active.name ?? 'sensevoice-small-int8',
          source: basename(source),
          sourceBytes: print.bytes,
          createdAt: new Date(now()).toISOString(),
          modelLoadMs,
          ...result,
        };
        if (cachePath) {
          await mkdir(cacheDir, { recursive: true });
          const temp = cachePath + '.' + process.pid + '.tmp';
          await writeFile(temp, JSON.stringify(record), 'utf8');
          await rename(temp, cachePath);
        }
        note('asr-transcript-ready', { segments: result.segments.length, rtf: result.stats?.rtf ?? null, cached: false });
        return { ...record, cached: false };
      } finally {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  /**
   * Direct bounded in-memory dictation recognition (WAV 16 kHz mono/stereo -> mono Float32).
   * Shares the same SenseVoice recognizer and single-flight queue; never triggers
   * background model download and never touches project media or cloud APIs.
   */
  async function transcribeAudioBuffer({ wavBuffer, lang = 'auto', signal } = {}) {
    signal?.throwIfAborted?.();
    const buf = Buffer.isBuffer(wavBuffer) ? wavBuffer : Buffer.from(wavBuffer || []);
    if (buf.length < 44 || buf.length > MAX_DICTATION_BYTES) {
      throw fail('录音数据为空或超出 16 MB 长度限制', 'DICTATION_SIZE');
    }
    const header = parseWavHeader(buf);
    if (header.sampleRate !== 16000) {
      throw fail(`听写只支持 16 kHz 采样率，收到 ${header.sampleRate} Hz`, 'BAD_SAMPLE_RATE');
    }
    if (header.durationSec > MAX_DICTATION_SEC) {
      throw fail(`单次听写最长 ${MAX_DICTATION_SEC} 秒`, 'DICTATION_TOO_LONG');
    }
    const state = await modelState({ env });
    if (!state.ready) {
      throw fail(
        `未安装本地语音模型（${SENSE_VOICE.label}，约 ${Math.round(SENSE_VOICE.bytes / 1024 / 1024)} MB）。请先下载并启用后再使用语音听写。`,
        'MODEL_NOT_READY',
      );
    }

    const bytesPerSample = header.bitsPerSample / 8;
    const frameBytes = bytesPerSample * header.channels;
    const frames = Math.min(
      header.sampleCount,
      Math.floor((buf.length - header.dataOffset) / frameBytes),
    );
    const samples = new Float32Array(frames);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const isFloat = header.format === 3;
    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      for (let c = 0; c < header.channels; c += 1) {
        const at = header.dataOffset + (i * header.channels + c) * bytesPerSample;
        sum += isFloat ? view.getFloat32(at, true) : view.getInt16(at, true) / 32768;
      }
      samples[i] = sum / header.channels;
    }

    // Check RMS energy quickly to avoid decoding pure digital zero
    let sumSq = 0;
    for (let i = 0; i < samples.length; i += 1) sumSq += samples[i] * samples[i];
    const rms = samples.length ? Math.sqrt(sumSq / samples.length) : 0;
    if (rms < 1e-4) {
      return {
        text: '',
        empty: true,
        modelId: SENSE_VOICE.id,
        runnerVersion: RUNNER_VERSION,
        format: 'wav-16khz',
        durationSec: Math.round(header.durationSec * 100) / 100,
        supportedLanguages: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'],
      };
    }

    return enqueue(async () => {
      signal?.throwIfAborted?.();
      const active = makeRecognizer(lang);
      try {
        active.warm?.();
      } catch (error) {
        throw fail('语音识别引擎没有加载成功：' + String(error?.message || error).slice(0, 200), error?.code ?? 'ENGINE_FAILED');
      }
      const decoded = await active.transcribe(samples, { sampleRate: 16000 });
      const text = String(decoded?.text ?? '').trim();
      return {
        text,
        empty: !text,
        modelId: active.name ?? SENSE_VOICE.id,
        runnerVersion: RUNNER_VERSION,
        format: 'wav-16khz',
        durationSec: Math.round(header.durationSec * 100) / 100,
        supportedLanguages: ['auto', 'zh', 'en', 'ja', 'ko', 'yue'],
      };
    });
  }

  return {
    transcribe,
    transcribeAudioBuffer,
    status,
    setup: () => startInstall(),
    cancelInstall,
    isBusy: () => busyJobs > 0,
    resetRecognizer: () => { recognizer = null; recognizerLang = null; },
    /** Test seam: wait for the queue to drain. */
    drain: () => chain,
  };
}
