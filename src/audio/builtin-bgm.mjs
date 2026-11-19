/**
 * Built-in BGM catalog (`We Never · 若如初见`, etc.):
 *   - Measured rhythm metadata (~26 KB JSON) ships directly inside `vendor/media/bgm/`.
 *   - Full MP3 audio resolves in priority order:
 *       1) bundled file under `vendor/media/bgm/<fileName>` (if present),
 *       2) global cache `$DSH_HOME/no996-openfilm/media/bgm/<fileName>` (SHA-256 verified),
 *       3) multi-source HTTP download with stall-watch & SHA-256 verification into global cache.
 *   - Once cached, all projects reuse it offline with zero extra network traffic.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFfmpeg, runFfmpeg } from '../asr/asr-audio.mjs';
import { bgmSourceUrls } from '../host/download-sources.mjs';
import { createStallWatch, DEFAULT_CONNECT_MS, DEFAULT_IDLE_MS, stallReason } from '../host/download-stall.mjs';
import { writeJsonAtomic, writeRhythmDataJs } from './rhythm-analyzer.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BUNDLED_BGM_DIR = join(PACKAGE_ROOT, 'vendor', 'media', 'bgm');

export const BUILTIN_BGM_CATALOG = Object.freeze([
  Object.freeze({
    id: 'vibe-we-never',
    title: 'We Never · 若如初见',
    fileName: 'we-never.mp3',
    rhythmFile: 'vibe-we-never.rhythm.json',
    durationSec: 189.824542,
    bpm: 112.3,
    sha256: '9d27ffec5594d66f15057e762363cba46783203875483bbecca8729d7b1441c1',
    tags: ['vibe', '知识大赏', '科普', '卡点', '节奏', '电子', '律动'],
    description: 'Vibe 知识大赏标志性官方配乐（189.8s / 112.3 BPM），随插件附带全部 348 主拍与 873 起音实测数据。',
  }),
]);

export function sha256Buffer(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function verifyFileSha256(filePath, expectedSha256) {
  if (!existsSync(filePath)) return false;
  try {
    const hash = sha256Buffer(readFileSync(filePath));
    return hash === expectedSha256;
  } catch {
    return false;
  }
}

export function getBuiltinBgmSpec(id = 'vibe-we-never') {
  return BUILTIN_BGM_CATALOG.find(item => item.id === id) ?? null;
}

export function loadBuiltinRhythm(id = 'vibe-we-never', { bgmDir = BUNDLED_BGM_DIR } = {}) {
  const spec = getBuiltinBgmSpec(id);
  if (!spec) throw new Error(`未知内置音乐：${id}`);
  const file = join(bgmDir, spec.rhythmFile);
  if (!existsSync(file)) throw new Error(`内置拍点文件缺失：${spec.rhythmFile}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function globalBgmCachePath(spec, { home = process.env.DSH_HOME || join(homedir(), '.dsh') } = {}) {
  return join(home, 'no996-openfilm', 'media', 'bgm', spec.fileName);
}

async function downloadBgmBytes(urls, expectedSha256, {
  fetchImpl = globalThis.fetch,
  connectTimeoutMs = DEFAULT_CONNECT_MS,
  idleTimeoutMs = DEFAULT_IDLE_MS,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境缺少 fetch，无法下载内置音乐。');
  const failures = [];
  for (const source of urls) {
    const stall = createStallWatch({ connectMs: connectTimeoutMs, idleMs: idleTimeoutMs, signal });
    try {
      const response = await fetchImpl(source.url, { redirect: 'follow', signal: stall.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      stall.connected();
      const chunks = [];
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        for (;;) {
          if (stall.signal.aborted) throw stallReason(stall.signal.reason) || stall.signal.reason || new Error('下载中止');
          const { done, value } = await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
              if (stall.signal.aborted) reject(stallReason(stall.signal.reason) || stall.signal.reason);
              else stall.signal.addEventListener('abort', () => reject(stallReason(stall.signal.reason) || stall.signal.reason), { once: true });
            }),
          ]);
          if (done) break;
          stall.activity();
          chunks.push(Buffer.from(value));
        }
      } else {
        stall.activity();
        chunks.push(Buffer.from(await response.arrayBuffer()));
      }
      stall.clear();
      const bytes = Buffer.concat(chunks);
      const actual = sha256Buffer(bytes);
      if (actual !== expectedSha256) {
        throw new Error(`SHA-256 校验不匹配（期望 ${expectedSha256.slice(0, 12)}，实际 ${actual.slice(0, 12)}）`);
      }
      return { bytes, sourceId: source.id };
    } catch (error) {
      stall.clear();
      const stalled = stallReason(error) || (error?.name === 'AbortError' ? stallReason(error.cause) : null);
      const message = stalled ? stalled.message : String(error?.message || error).slice(0, 140);
      failures.push(`${source.id}: ${message}`);
    }
  }
  throw new Error(`内置音乐下载失败（${failures.join('；')}）。可导入本地音频或设置 NO996_OPENFILM_BGM_BASE_URL 镜像。`);
}

/**
 * Resolve the local MP3 path for a built-in BGM track.
 * Downloads once into `$DSH_HOME/no996-openfilm/media/bgm/` with SHA-256 verification.
 */
export async function resolveBuiltinBgmFile(id = 'vibe-we-never', {
  bgmDir = BUNDLED_BGM_DIR,
  home = process.env.DSH_HOME || join(homedir(), '.dsh'),
  env = process.env,
  fetchImpl = globalThis.fetch,
  connectTimeoutMs = DEFAULT_CONNECT_MS,
  idleTimeoutMs = DEFAULT_IDLE_MS,
  signal,
} = {}) {
  const spec = getBuiltinBgmSpec(id);
  if (!spec) throw new Error(`未知内置音乐：${id}`);

  const bundledFile = join(bgmDir, spec.fileName);
  if (verifyFileSha256(bundledFile, spec.sha256)) {
    return { spec, file: bundledFile, source: 'bundled' };
  }

  const cacheFile = globalBgmCachePath(spec, { home });
  if (verifyFileSha256(cacheFile, spec.sha256)) {
    return { spec, file: cacheFile, source: 'cache' };
  }

  const urls = bgmSourceUrls(id, env);
  if (urls.length === 0) throw new Error(`内置音乐 ${id} 没有配置可用下载源。`);
  const { bytes, sourceId } = await downloadBgmBytes(urls, spec.sha256, {
    fetchImpl,
    connectTimeoutMs,
    idleTimeoutMs,
    signal,
  });

  mkdirSync(dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.part`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, cacheFile);
  return { spec, file: cacheFile, source: `download:${sourceId}` };
}

/**
 * Install a built-in BGM + its precomputed measured rhythm into an OpenFilm project.
 * Optionally trims to `trimDuration` seconds with a smooth fade-out via FFmpeg.
 */
export async function installBuiltinBgmToProject({
  id = 'vibe-we-never',
  projectPath,
  trimDuration = null,
  fadeOut = 1.2,
  bgmDir = BUNDLED_BGM_DIR,
  home,
  env,
  fetchImpl,
  resolveFfmpegBin = resolveFfmpeg,
  runFfmpegBin = runFfmpeg,
  signal,
} = {}) {
  if (!projectPath) throw new Error('installBuiltinBgmToProject requires projectPath');
  const analysis = loadBuiltinRhythm(id, { bgmDir });
  const resolved = await resolveBuiltinBgmFile(id, { bgmDir, home, env, fetchImpl, signal });
  const relAudio = `assets/audio/bgm/${resolved.spec.fileName}`;
  const targetAudio = join(projectPath, ...relAudio.split('/'));
  mkdirSync(dirname(targetAudio), { recursive: true });

  let appliedTrim = null;
  if (Number.isFinite(trimDuration) && trimDuration > 1 && trimDuration < resolved.spec.durationSec - 0.2) {
    const dur = Number(trimDuration.toFixed(3));
    const fade = Math.min(Math.max(0.2, Number(fadeOut) || 1.2), dur * 0.4);
    const fadeStart = Math.max(0, dur - fade).toFixed(3);
    const ffmpeg = await resolveFfmpegBin();
    const tmpOut = `${targetAudio}.${process.pid}.trim.mp3`;
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', resolved.file,
      '-t', String(dur),
      '-af', `afade=t=out:st=${fadeStart}:d=${fade.toFixed(3)}`,
      '-ar', '48000', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k',
      tmpOut,
    ];
    const res = await runFfmpegBin(ffmpeg, args, { workDir: dirname(targetAudio), timeoutMs: 60_000, signal });
    if (res.code !== 0) {
      throw new Error(`裁剪内置 BGM 失败：${String(res.stderr || `exit ${res.code}`).slice(0, 180)}`);
    }
    renameSync(tmpOut, targetAudio);
    appliedTrim = dur;
  } else {
    const tmpCopy = `${targetAudio}.${process.pid}.part`;
    copyFileSync(resolved.file, tmpCopy);
    renameSync(tmpCopy, targetAudio);
  }

  const rhythmCachePath = join(projectPath, '.film', 'rhythm.json');
  writeJsonAtomic(rhythmCachePath, {
    version: 1,
    source: relAudio,
    sha256: resolved.spec.sha256,
    analysis,
  });

  const dataJsRel = 'assets/rhythm-data.js';
  writeRhythmDataJs(join(projectPath, ...dataJsRel.split('/')), analysis, {
    source: relAudio,
    sha256: resolved.spec.sha256,
  });

  return {
    spec: resolved.spec,
    source: resolved.source,
    relAudio,
    dataJsRel,
    rhythmCacheRel: '.film/rhythm.json',
    trimmedToSec: appliedTrim,
    analysis,
  };
}
