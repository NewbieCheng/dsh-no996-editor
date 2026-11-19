/**
 * `openfilm_rhythm`: measure real beats, percussive/tonal onsets, energy curves,
 * climaxes, drops and quiet valleys from any audio or video inside the project.
 *
 * Pure Node.js + bundled FFmpeg (zero Python). Results are cached by SHA-256 in
 * `.film/rhythm.json` and optionally emitted as `assets/rhythm-data.js` (`window.RHYTHM`).
 */
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  analyzeAudioSamples,
  extractMonoFloat32,
  hashFileSha256,
  planRhythmEvents,
  readCachedRhythm,
  writeJsonAtomic,
  writeRhythmDataJs,
} from '../audio/rhythm-analyzer.mjs';

const AUDIO_OR_VIDEO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus|mp4|mov|mkv|webm|avi)$/i;

async function resolveProjectFile(projectRoot, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim() || /[:\u0000-\u001f]/.test(relPath)) {
    throw new Error('请传项目内的相对路径（例如 assets/bgm/track.mp3）。');
  }
  const clean = relPath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (clean.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('路径不能包含 .. 或空段，只能读取项目内文件。');
  }
  const canonicalRoot = await realpath(projectRoot);
  const full = await realpath(join(canonicalRoot, ...clean.split('/'))).catch(() => null);
  const rel = full ? relative(canonicalRoot, full) : '';
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`找不到项目内文件：${clean}（外部文件请先用 openfilm_assets 导入）。`);
  }
  const info = await stat(full);
  if (!info.isFile()) throw new Error(`路径不是文件：${clean}`);
  if (!AUDIO_OR_VIDEO_EXT.test(full)) {
    throw new Error(`不支持的音频/视频扩展名：${clean}`);
  }
  return { canonicalRoot, full, rel: clean };
}

function fmtSec(sec) {
  return `${Number(sec).toFixed(2)}s`;
}

export function formatRhythmSummary({ rel, analysis, plan, cached, dataJsRel }) {
  const lines = [
    `音乐/音频实测节奏分析（${rel}${cached ? '，命中缓存' : ''}）：`,
    `· 时长：${analysis.durationSec.toFixed(2)}s | 估算 BPM：${analysis.bpm || '未知'} | 主拍：${analysis.beats.length} 个 | 打击起音：${analysis.onsets.length} 个 | 旋律起音：${analysis.tonal.length} 个`,
  ];
  if (analysis.climaxes.length) {
    lines.push(`· 高潮段落（适合强动效/能量爆发）：${analysis.climaxes.slice(0, 6).map(c => `${fmtSec(c.start)}–${fmtSec(c.end)} (峰值 ${fmtSec(c.peakAt)})`).join('；')}`);
  } else {
    lines.push('· 高潮段落：能量较平稳（无明显大幅峰值段落）');
  }
  if (analysis.drops.length) {
    lines.push(`· 陡升冲击点（Drop）：${analysis.drops.slice(0, 8).map(d => fmtSec(d.at)).join('、')}`);
  }
  if (analysis.valleys.length) {
    lines.push(`· 平静谷底（适合留白/慢读字幕）：${analysis.valleys.slice(0, 6).map(v => `${fmtSec(v.start)}–${fmtSec(v.end)}`).join('；')}`);
  }
  if (plan.sceneEvents.length) {
    const preview = plan.sceneEvents.slice(0, 12).map(e => `b${e.beatIndex}@${e.timeSec.toFixed(2)}s`).join(' ');
    lines.push(`· 建议主拍切镜候选：${preview}${plan.sceneEvents.length > 12 ? ` …共 ${plan.sceneEvents.length} 个` : ''}`);
  }
  lines.push('· 已缓存：.film/rhythm.json');
  if (dataJsRel) lines.push(`· 已写出静态数据脚本：${dataJsRel}（页面可用 <script src="../${dataJsRel}"></script> 读取 window.RHYTHM）`);
  return lines.join('\n');
}

export function createRhythmTool({ isProjectAgent, projectOf, extract = extractMonoFloat32 } = {}) {
  return {
    name: 'openfilm_rhythm',
    description: 'Analyze an audio or video file inside the OpenFilm project in pure Node.js + FFmpeg to extract measured beats, percussive/tonal onsets, BPM, energy curve, climaxes, drops and quiet valleys. Caches `.film/rhythm.json` and optionally writes `assets/rhythm-data.js` (`window.RHYTHM`).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['source'],
      properties: {
        source: { type: 'string', description: 'Project-relative audio or video path (e.g. assets/bgm/track.mp3).' },
        beatsPerScene: { type: 'integer', minimum: 1, maximum: 32, description: 'Beat stride for scene cut suggestions (default 4).' },
        writeDataJs: { type: 'boolean', description: 'Also write assets/rhythm-data.js defining window.RHYTHM (default true).' },
        force: { type: 'boolean', description: 'Recompute even if SHA-256 matches .film/rhythm.json.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof isProjectAgent !== 'function' || isProjectAgent(exec?.agent) !== true) {
        throw new Error('This tool is available only to a conversation bound to an OpenFilm project.');
      }
      const project = projectOf?.(exec.agent);
      if (!project?.projectId || !project?.path) {
        throw new Error('This conversation is not bound to an OpenFilm project.');
      }

      const { canonicalRoot, full, rel } = await resolveProjectFile(project.path, args?.source);
      const sha256 = await hashFileSha256(full);
      const cachePath = join(canonicalRoot, '.film', 'rhythm.json');
      const writeJs = args?.writeDataJs !== false;
      const dataJsRel = 'assets/rhythm-data.js';
      const dataJsPath = join(canonicalRoot, ...dataJsRel.split('/'));

      let cachedRecord = args?.force === true ? null : readCachedRhythm(cachePath, sha256);
      let cached = Boolean(cachedRecord);
      let analysis = cachedRecord?.analysis;
      if (!analysis) {
        const { samples, sampleRate } = await extract(full, { signal: exec?.signal });
        analysis = analyzeAudioSamples(samples, sampleRate);
        writeJsonAtomic(cachePath, { version: 1, source: rel, sha256, analysis });
        cached = false;
      }

      if (writeJs && (!cached || !existsSync(dataJsPath))) {
        writeRhythmDataJs(dataJsPath, analysis, { source: rel, sha256 });
      }
      const plan = planRhythmEvents(analysis, { beatsPerScene: args?.beatsPerScene ?? 4 });
      return {
        text: formatRhythmSummary({
          rel,
          analysis,
          plan,
          cached,
          dataJsRel: writeJs ? dataJsRel : '',
        }),
      };
    },
  };
}
