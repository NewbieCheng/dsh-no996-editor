/**
 * `no996_audio`: multimodal audio toolkit (pure Node.js + bundled FFmpeg, zero Python).
 *
 * Actions:
 *   - `extract`: extract 48 kHz stereo audio from a project video + detect silence/active speech segments & volume.
 *   - `bgm-list`: list built-in BGM tracks (default `vibe-we-never`: We Never · 若如初见).
 *   - `bgm-install`: install built-in BGM + precomputed measured rhythm (`assets/rhythm-data.js`, `.film/rhythm.json`).
 *   - `duck`: render a ducked BGM track (`-12 dB` under dialogue/speech ranges) ready for `film.html`.
 */
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { BUILTIN_BGM_CATALOG, installBuiltinBgmToProject } from '../audio/builtin-bgm.mjs';
import { extractProjectAudio, renderDuckedBgm } from '../audio/audio-ops.mjs';

const MEDIA_EXT = /\.(mp4|mov|mkv|webm|avi|mp3|wav|m4a|aac|flac|ogg|opus)$/i;

async function resolveInside(projectRoot, rawRel, { mustExist = true, requireAudioDir = false, allowedExt = MEDIA_EXT } = {}) {
  if (typeof rawRel !== 'string' || !rawRel.trim() || /[:\u0000-\u001f]/.test(rawRel)) {
    throw new Error('请使用项目内相对路径（例如 assets/take.mp4 或 assets/audio/bgm.wav）。');
  }
  const clean = rawRel.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (clean.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('路径不能包含 .. 或空段。');
  }
  if (requireAudioDir && !clean.startsWith('assets/audio/')) {
    throw new Error('输出音频路径必须位于 assets/audio/ 下。');
  }
  const canonicalRoot = await realpath(projectRoot);
  if (mustExist) {
    const full = await realpath(join(canonicalRoot, ...clean.split('/'))).catch(() => null);
    const rel = full ? relative(canonicalRoot, full) : '';
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`找不到项目内文件：${clean}（外部文件请先用 no996_assets 导入）。`);
    }
    const info = await stat(full);
    if (!info.isFile()) throw new Error(`路径不是文件：${clean}`);
    if (allowedExt && !allowedExt.test(full)) throw new Error(`不支持的音视频格式：${clean}`);
    return { canonicalRoot, full, rel: clean };
  }
  const target = join(canonicalRoot, ...clean.split('/'));
  const rel = relative(canonicalRoot, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('输出路径越界。');
  }
  if (allowedExt && !allowedExt.test(target)) throw new Error(`输出扩展名不支持：${clean}`);
  return { canonicalRoot, full: target, rel: clean };
}

function fmtRanges(list, limit = 14) {
  if (!list.length) return '无';
  const head = list.slice(0, limit).map(r => `${r.start.toFixed(2)}–${r.end.toFixed(2)}s`).join('、');
  return list.length > limit ? `${head} …共 ${list.length} 段` : head;
}

export function createAudioTool({
  isProjectAgent,
  projectOf,
  installBgm = installBuiltinBgmToProject,
  extractAudio = extractProjectAudio,
  duckBgm = renderDuckedBgm,
} = {}) {
  return {
    name: 'no996_audio',
    description: 'Extract audio & speech/silence intervals from a project video (`extract`), list/install built-in Vibe BGM (`bgm-list`, `bgm-install` with `We Never · 若如初见` + measured beats), or render a ducked BGM track under dialogue (`duck`). Pure Node.js + bundled FFmpeg.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['extract', 'bgm-list', 'bgm-install', 'duck'],
          description: 'Operation: extract audio & speech timings; list built-in BGM; install built-in BGM + rhythm; or duck BGM under speech.',
        },
        source: { type: 'string', description: 'Project-relative media path (for extract or duck BGM source).' },
        out: { type: 'string', description: 'Project-relative output path under assets/audio/.' },
        format: { type: 'string', enum: ['wav', 'mp3'], description: 'extract output format (default wav).' },
        bgmId: { type: 'string', description: 'Built-in BGM id (default vibe-we-never).' },
        duration: { type: 'number', minimum: 1, maximum: 600, description: 'Optional target duration in seconds to trim BGM with smooth fade-out.' },
        fadeOut: { type: 'number', minimum: 0.2, maximum: 5, description: 'Fade-out tail seconds when trimming BGM (default 1.2).' },
        volume: { type: 'number', minimum: 0.05, maximum: 1.5, description: 'Suggested BGM playback/normal gain (default 0.45).' },
        duckDb: { type: 'number', minimum: -30, maximum: -2, description: 'BGM gain reduction during speech in dB (default -12).' },
        speechRanges: {
          type: 'array',
          maxItems: 200,
          description: 'Active speech/dialogue intervals [{ start, end }] in seconds (from extract or no996_transcribe).',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['start', 'end'],
            properties: {
              start: { type: 'number', minimum: 0 },
              end: { type: 'number', minimum: 0 },
            },
          },
        },
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
      const action = args?.action;

      if (action === 'bgm-list') {
        const lines = BUILTIN_BGM_CATALOG.map(item =>
          `· ${item.id}（${item.title} | ${item.durationSec.toFixed(1)}s | ${item.bpm} BPM）：${item.description}`,
        );
        return {
          text: [
            '内置专属配乐库（随插件附带实测拍点，首次使用自动缓存音频至本机）：',
            ...lines,
            '调用 action="bgm-install" 即可把配乐与实测拍点（assets/rhythm-data.js）直接装入当前项目。',
          ].join('\n'),
        };
      }

      if (action === 'bgm-install') {
        const id = typeof args?.bgmId === 'string' && args.bgmId.trim() ? args.bgmId.trim() : 'vibe-we-never';
        const installed = await installBgm({
          id,
          projectPath: project.path,
          trimDuration: args?.duration ?? null,
          fadeOut: args?.fadeOut ?? 1.2,
          signal: exec?.signal,
        });
        const durTag = installed.trimmedToSec ? `（已按 ${installed.trimmedToSec}s 裁剪并加淡出）` : `（完整 ${installed.spec.durationSec.toFixed(1)}s）`;
        const climaxes = (installed.analysis.climaxes || []).map(c => `${c.start}–${c.end}s`).join('、') || '平稳推进';
        const drops = (installed.analysis.drops || []).map(d => `${d.at}s`).join('、') || '无';
        const vol = args?.volume !== undefined ? Number(args.volume) : 0.45;
        return {
          text: [
            `已装入内置配乐「${installed.spec.title}」：${installed.relAudio}${durTag}（来源：${installed.source}）`,
            `· 实测拍点已写入：${installed.dataJsRel} 与 ${installed.rhythmCacheRel}（BPM ${installed.analysis.bpm}，主拍 ${installed.analysis.beats.length}，起音 ${installed.analysis.onsets.length}）`,
            `· 高潮区间：${climaxes} | 能量陡升 Drop：${drops}`,
            `· film.html 可直接挂载（无口播建议 volume="0.55"，有口播请先用 action="duck"）：\n<section id="bgm" title="背景音乐">\n  <audio id="bgm-main" src="${installed.relAudio}#t=0,${installed.trimmedToSec ?? installed.spec.durationSec.toFixed(3)}" at="0" volume="${vol}"></audio>\n</section>`,
          ].join('\n'),
        };
      }

      if (action === 'extract') {
        const src = await resolveInside(project.path, args?.source, { mustExist: true });
        const fmt = args?.format === 'mp3' ? 'mp3' : 'wav';
        const stem = src.rel.split('/').pop().replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_') || 'track';
        const defaultOut = `assets/audio/extracted-${stem}.${fmt}`;
        const dst = await resolveInside(project.path, args?.out || defaultOut, {
          mustExist: false,
          requireAudioDir: true,
          allowedExt: /\.(wav|mp3)$/i,
        });
        const result = await extractAudio({
          sourceFull: src.full,
          targetFull: dst.full,
          format: fmt,
          signal: exec?.signal,
        });
        return {
          text: [
            `已提取独立音轨：${dst.rel}（时长 ${result.durationSec}s，${Math.round(result.bytes / 1024)} KB）`,
            `· 响度均值：${result.volume.meanDb ?? '?'} dB | 峰值：${result.volume.maxDb ?? '?'} dB`,
            `· 说话/活跃段（可直接传给 action="duck" 的 speechRanges）：${fmtRanges(result.activeSegments)}`,
            `· 静音/停顿区间（适合切镜或呼吸留白）：${fmtRanges(result.silences)}`,
          ].join('\n'),
        };
      }

      // action === 'duck'
      const bgmSrc = await resolveInside(project.path, args?.source || 'assets/audio/bgm/we-never.mp3', { mustExist: true });
      const dst = await resolveInside(project.path, args?.out || 'assets/audio/bgm-ducked.wav', {
        mustExist: false,
        requireAudioDir: true,
        allowedExt: /\.wav$/i,
      });
      const result = await duckBgm({
        bgmFull: bgmSrc.full,
        targetFull: dst.full,
        speechRanges: args?.speechRanges ?? [],
        normalGain: args?.volume ?? 0.48,
        duckDb: args?.duckDb ?? -12,
        duration: args?.duration ?? null,
        fadeOut: args?.fadeOut ?? 1.2,
        signal: exec?.signal,
      });
      return {
        text: [
          `已生成人声闪避混音轨：${dst.rel}（时长 ${result.durationSec}s，闪避 ${result.mergedRanges.length} 段，人声期压低 ${args?.duckDb ?? -12} dB）`,
          `可直接放入 film.html：\n<section id="bgm" title="背景音乐（人声闪避）">\n  <audio id="bgm-ducked" src="${dst.rel}#t=0,${result.durationSec}" at="0"></audio>\n</section>`,
        ].join('\n'),
      };
    },
  };
}
