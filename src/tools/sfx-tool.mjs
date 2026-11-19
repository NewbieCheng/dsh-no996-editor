/**
 * `no996_sfx`: synthesize deterministic 48 kHz stereo action SFX directly into
 * the OpenFilm project (pure Node.js, zero Python).
 *
 * Strictly complies with OpenFilm's timeline rules (`SPEC.md` §Sound):
 *   - `mode="clips"`: generates short `.wav` files under `assets/audio/sfx/` and
 *     packs cues into non-overlapping `<section id="sfx-...">` lanes ready for `film.html`.
 *   - `mode="stem"`: renders one sample-accurate stereo stem (`assets/audio/sfx-stem.wav`)
 *     for high-density rhythms/grids so `film.html` needs only 1 audio track.
 *   - `mode="list"`: prints all 12 built-in procedural SFX kinds and usage guidance.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  packCuesToLanes,
  renderSfxStem,
  SFX_CATALOG,
  SFX_KINDS,
  synthesizeSfxWav,
} from '../audio/sfx-synth.mjs';

const MAX_CUES = 500;
const MAX_DURATION = 600;

function writeAtomic(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filePath);
}

async function resolveAudioOutput(projectRoot, rawOut) {
  const rel = (typeof rawOut === 'string' && rawOut.trim() ? rawOut.trim() : 'assets/audio/sfx-stem.wav')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
  if (!rel.startsWith('assets/audio/') || !rel.endsWith('.wav') || /[:\u0000-\u001f]/.test(rel)) {
    throw new Error('输出路径必须在 assets/audio/ 下并以 .wav 结尾（例如 assets/audio/sfx-stem.wav）。');
  }
  if (rel.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('输出路径不能包含 .. 或空段。');
  }
  const canonicalRoot = await realpath(projectRoot);
  const target = join(canonicalRoot, ...rel.split('/'));
  const inside = relative(canonicalRoot, target);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('输出路径越界。');
  }
  return { canonicalRoot, target, rel };
}

function validateCues(rawCues) {
  if (!Array.isArray(rawCues) || rawCues.length === 0) {
    throw new Error('请至少提供 1 条音效 cue（{ at, kind }）。');
  }
  if (rawCues.length > MAX_CUES) {
    throw new Error(`单次最多合成 ${MAX_CUES} 条音效 cue。`);
  }
  const cues = [];
  for (const [idx, item] of rawCues.entries()) {
    if (!item || typeof item !== 'object') throw new Error(`第 ${idx + 1} 条 cue 必须是对象。`);
    const kind = String(item.kind || '').trim();
    if (!SFX_CATALOG[kind]) {
      throw new Error(`第 ${idx + 1} 条 cue 的 kind "${kind}" 不受支持（可选：${SFX_KINDS.join(', ')}）。`);
    }
    const at = Number(item.at);
    if (!Number.isFinite(at) || at < 0 || at > MAX_DURATION) {
      throw new Error(`第 ${idx + 1} 条 cue 的 at 必须是 0..${MAX_DURATION} 的秒数。`);
    }
    const gain = item.gain === undefined ? 1 : Number(item.gain);
    if (!Number.isFinite(gain) || gain < 0.05 || gain > 2) {
      throw new Error(`第 ${idx + 1} 条 cue 的 gain 必须在 0.05..2 之间。`);
    }
    const pitch = item.pitch === undefined ? undefined : Number(item.pitch);
    if (pitch !== undefined && (!Number.isFinite(pitch) || pitch < 20 || pitch > 10000)) {
      throw new Error(`第 ${idx + 1} 条 cue 的 pitch 必须在 20..10000 Hz 之间。`);
    }
    const duration = item.duration === undefined ? undefined : Number(item.duration);
    if (duration !== undefined && (!Number.isFinite(duration) || duration < 0.02 || duration > 10)) {
      throw new Error(`第 ${idx + 1} 条 cue 的 duration 必须在 0.02..10 秒之间。`);
    }
    cues.push({
      at: Number(at.toFixed(3)),
      kind,
      gain: Number(gain.toFixed(3)),
      ...(pitch !== undefined ? { pitch } : {}),
      ...(duration !== undefined ? { duration } : {}),
    });
  }
  return cues;
}

export function createSfxTool({ isProjectAgent, projectOf } = {}) {
  return {
    name: 'no996_sfx',
    description: 'Synthesize deterministic 48kHz stereo action SFX `.wav` files into the project (pure Node.js, zero Python). Use `mode="list"` to inspect the 12 built-in SFX kinds; `mode="clips"` to write individual `.wav` clips and get zero-overlap `<section>` tracks for `film.html`; or `mode="stem"` to render a single sample-accurate mixed `sfx-stem.wav` for dense cues.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['list', 'clips', 'stem'], description: 'Operation mode (default clips).' },
        cues: {
          type: 'array',
          maxItems: MAX_CUES,
          description: 'Action sound events [{ at, kind, gain?, pitch?, duration? }].',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['at', 'kind'],
            properties: {
              at: { type: 'number', minimum: 0, maximum: MAX_DURATION, description: 'Start time on film timeline in seconds.' },
              kind: { type: 'string', enum: SFX_KINDS, description: 'SFX primitive kind.' },
              gain: { type: 'number', minimum: 0.05, maximum: 2, description: 'Relative gain (default 1).' },
              pitch: { type: 'number', minimum: 20, maximum: 10000, description: 'Fundamental Hz for bell.' },
              duration: { type: 'number', minimum: 0.02, maximum: 10, description: 'Optional override duration in seconds.' },
            },
          },
        },
        duration: { type: 'number', minimum: 0.5, maximum: MAX_DURATION, description: 'Total stem duration in seconds (for mode="stem").' },
        gain: { type: 'number', minimum: 0.05, maximum: 1.5, description: 'Master SFX gain for stem mix (default 0.65).' },
        out: { type: 'string', description: 'Output stem path inside assets/audio/*.wav (default assets/audio/sfx-stem.wav).' },
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

      const mode = args?.mode ?? 'clips';
      if (mode === 'list') {
        const lines = SFX_KINDS.map(kind => `· ${kind}（${SFX_CATALOG[kind].duration}s）—— ${SFX_CATALOG[kind].desc}`);
        return { text: `可用程序化动作音效（48 kHz 立体声 WAV）：\n${lines.join('\n')}` };
      }

      const cues = validateCues(args?.cues);
      const canonicalRoot = await realpath(project.path);
      writeAtomic(
        join(canonicalRoot, '.film', 'sfx-cues.json'),
        Buffer.from(`${JSON.stringify({ version: 1, mode, cues }, null, 2)}\n`, 'utf8'),
      );

      if (mode === 'stem') {
        const { target, rel } = await resolveAudioOutput(project.path, args?.out);
        const maxAt = Math.max(...cues.map(c => c.at + (c.duration ?? SFX_CATALOG[c.kind].duration)));
        const totalDuration = args?.duration !== undefined ? Number(args.duration) : Math.min(MAX_DURATION, Math.max(2, maxAt + 0.5));
        const masterGain = args?.gain !== undefined ? Number(args.gain) : 0.65;
        const stem = renderSfxStem(cues, totalDuration, { gain: masterGain });
        writeAtomic(target, stem.wav);
        const clipTag = `<section id="sfx" title="动作音效">\n  <audio id="sfx-stem" src="${rel}#t=0,${stem.duration}" at="0"></audio>\n</section>`;
        return {
          text: [
            `已合成单轨音效 Stem：${rel}（${cues.length} 条 cue，时长 ${stem.duration}s，峰值 ${stem.peakDb} dBFS）。`,
            '请将以下音轨放入 film.html（若已有语音/配乐轨，请确保不挤占主轨）：',
            clipTag,
          ].join('\n\n'),
        };
      }

      // mode === 'clips': generate reusable per-signature wav files & non-overlapping lanes.
      const files = new Map();
      const normalizedCues = [];
      for (const cue of cues) {
        const pitchTag = cue.pitch !== undefined ? `-p${Math.round(cue.pitch)}` : '';
        const durTag = cue.duration !== undefined ? `-d${Math.round(cue.duration * 1000)}` : '';
        const filename = `${cue.kind}${pitchTag}${durTag}.wav`;
        const rel = `assets/audio/sfx/${filename}`;
        if (!files.has(rel)) {
          const { wav, duration } = synthesizeSfxWav(cue.kind, {
            pitch: cue.pitch,
            duration: cue.duration,
          });
          writeAtomic(join(canonicalRoot, ...rel.split('/')), wav);
          files.set(rel, duration);
        }
        normalizedCues.push({ ...cue, src: rel, duration: files.get(rel) });
      }

      const lanes = packCuesToLanes(normalizedCues);
      const laneNames = ['a', 'b', 'c', 'd'];
      const sectionsHtml = lanes.map((lane, i) => {
        const suffix = laneNames[i] ?? String(i + 1);
        const clips = lane.items.map((item, j) => {
          const vol = item.gain !== 1 ? ` volume="${item.gain}"` : '';
          return `  <audio id="sfx-${suffix}-${j + 1}" src="${item.src}#t=0,${item.duration}" at="${item.at}"${vol}></audio>`;
        }).join('\n');
        return `<section id="sfx-${suffix}" title="音效 ${suffix.toUpperCase()}">\n${clips}\n</section>`;
      }).join('\n');

      return {
        text: [
          `已合成 ${files.size} 个音效文件至 assets/audio/sfx/，并按 OpenFilm 零重叠约束排布为 ${lanes.length} 条音轨（共 ${normalizedCues.length} 个触发点）。`,
          '可直接写入 film.html：',
          sectionsHtml,
        ].join('\n\n'),
      };
    },
  };
}
