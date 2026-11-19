import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { resolveFfmpeg, runFfmpeg } from '../asr/asr-audio.mjs';
import { withVisionBrowser } from './vision-browser.mjs';

const maxSamples = 8;
const maxSeconds = 12 * 60 * 60;
const maxFrameBytes = 4 * 1024 * 1024;
const extensions = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.ts', '.png', '.jpg', '.jpeg', '.webp']);
const parameter = { type: 'string', description: 'Existing project-relative video/image path (e.g. assets/take.mp4). No external media or URLs.' };
const seconds = { type: 'number', minimum: 0, maximum: maxSeconds, description: 'Seconds from the start of the source media, not the film playhead.' };
const point = { type: 'object', required: ['x', 'y'], additionalProperties: false, properties: { x: { type: 'number' }, y: { type: 'number' } } };

async function localMedia(root, source) {
  // Reject URIs, UNC, drive-relative paths, ADS and raw traversal before touching disk.
  if (typeof source !== 'string' || !source || /[:\u0000-\u001f]/.test(source) || source.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) {
    throw new Error('请使用项目内素材的相对路径，不支持网址、绝对路径或目录穿越。');
  }
  const canonicalRoot = await realpath(root);
  const file = await realpath(join(canonicalRoot, ...source.split(/[\\/]/))).catch(() => null);
  const inside = file ? relative(canonicalRoot, file) : '';
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error('找不到项目内素材，或素材指向项目外部。请先把素材导入当前项目。');
  }
  if (!extensions.has(extname(file).toLowerCase()) || !(await stat(file)).isFile()) throw new Error('素材不是支持的视频或图片文件。');
  return file;
}

export async function extractVisionFrame(file, at, { workDir, signal, resolve = resolveFfmpeg, run = runFfmpeg } = {}) {
  signal?.throwIfAborted();
  const target = join(workDir, 'vision-frame.png');
  await rm(target, { force: true });
  const executable = await resolve();
  signal?.throwIfAborted();
  const result = await run(executable, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-n', '-max_alloc', '134217728', '-threads', '2',
    '-protocol_whitelist', 'file', '-format_whitelist', 'mov,matroska,webm,avi,mpegts,png_pipe,jpeg_pipe,webp_pipe',
    '-ss', String(at), '-i', file, '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-dn',
    '-vf', "scale='min(960,iw)':'min(960,ih)':force_original_aspect_ratio=decrease,setsar=1", '-c:v', 'png', '-threads', '1', '-update', '1', target,
  ], { workDir, signal, timeoutMs: 15_000 });
  signal?.throwIfAborted();
  const size = (await stat(target).catch(() => null))?.size ?? 0;
  if (result.code !== 0 || size === 0 || size > maxFrameBytes) throw new Error(`无法读取素材第 ${at} 秒的画面；请检查视频格式和时间是否超出素材。`);
  return readFile(target);
}

async function savePreview(root, at, bytes, signal) {
  signal?.throwIfAborted();
  const canonicalRoot = await realpath(root);
  let dir = canonicalRoot;
  for (const name of ['assets', 'vision']) {
    dir = join(dir, name);
    await mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const item = await lstat(dir);
    if (!item.isDirectory() || item.isSymbolicLink() || relative(dir, await realpath(dir))) throw new Error('抠像输出目录不是项目内的普通目录。');
  }
  const name = `cutout-${Math.round(at * 1000)}ms-${randomUUID()}.png`;
  const path = join(dir, name);
  signal?.throwIfAborted();
  // Never overwrite an existing asset (including a symlink), even on collision.
  const handle = await open(path, 'wx');
  try {
    signal?.throwIfAborted();
    await handle.writeFile(bytes);
    signal?.throwIfAborted();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  return `assets/vision/${name}`;
}

const numericTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maxSeconds;
const attachmentSchema = {
  type: 'object', additionalProperties: false, required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name'],
  properties: {
    attachmentId: { type: 'string' }, mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, name: { type: 'string' },
  },
};
const faceSchema = {
  type: 'object', additionalProperties: false, required: ['box', 'points'],
  properties: {
    box: { type: 'object', additionalProperties: false, required: ['left', 'top', 'right', 'bottom'], properties: Object.fromEntries(['left', 'top', 'right', 'bottom'].map(key => [key, { type: 'number' }])) },
    points: { type: 'object', additionalProperties: false, properties: Object.fromEntries(['leftEye', 'rightEye', 'nose', 'mouthLeft', 'mouthRight'].map(key => [key, point])) },
  },
};

export function createVisionTools({ isProjectAgent, projectOf, attachments, extract = extractVisionFrame, browser = withVisionBrowser } = {}) {
  async function run(args, exec, mode, times, callback) {
    const signal = exec?.signal;
    signal?.throwIfAborted();
    const project = isProjectAgent?.(exec?.agent) === true ? projectOf?.(exec.agent) : null;
    if (!project?.projectId || !project?.path) throw new Error('此工具仅对已绑定影片项目的对话开放。');
    const file = await localMedia(project.path, args?.source);
    signal?.throwIfAborted();
    const workDir = await mkdtemp(join(tmpdir(), 'no996-vision-'));
    try {
      return await browser(mode, async analyze => {
        const results = [];
        for (const at of times) {
          signal?.throwIfAborted();
          const bytes = await extract(file, at, { workDir, signal });
          results.push({ at, ...await analyze(bytes) });
        }
        signal?.throwIfAborted();
        // If the session binding moved while inference was running, withhold results.
        const current = projectOf?.(exec.agent);
        if (current?.projectId !== project.projectId || current?.path !== project.path) throw new Error('对话的影片项目已切换；视觉结果未提交。');
        return await callback(results, project);
      }, { signal });
    } finally {
      await rm(workDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }

  return [
    {
      name: 'no996_cutout',
      description: 'Preview local person cutout on one frame of a project asset: create a new transparent PNG in assets/vision, without modifying the source or timeline. Use source media seconds (not film seconds).',
      parameters: { type: 'object', additionalProperties: false, required: ['source'], properties: { source: parameter, at: seconds } },
      output: {
        schema: { type: 'object', required: ['text', 'path'], additionalProperties: false, properties: { text: { type: 'string' }, path: { type: 'string' }, image: attachmentSchema } },
        render: (_args, value) => [{ type: 'text', text: value.text }, ...(value.image ? [{ type: 'image', attachment: { ...value.image } }] : [])],
      },
      timeoutMs: 60_000,
      async execute(args, exec) {
        const at = args?.at ?? 0;
        if (!numericTime(at)) throw new Error('at 必须是 0–43200 的素材秒数。');
        return run(args, exec, 'cutout', [at], async ([result], project) => {
          const bytes = Buffer.from(result.png, 'base64');
          if (bytes.length < 26 || bytes.length > maxFrameBytes || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' || bytes[25] !== 6) {
            throw new Error('抠像未返回有效的透明 PNG。');
          }
          const path = await savePreview(project.path, at, bytes, exec?.signal);
          const text = `素材第 ${at} 秒的人像抠像预览：${path}。可在素材库打开；未修改源素材或时间轴。${result.foregroundFraction < 0.01 ? '这一帧没有检测到明显人物。' : ''}`;
          // The project PNG is the primary output. An attachment is optional so
          // the preview still works on Hosts without an image store.
          const store = typeof attachments === 'function' ? attachments() : attachments;
          if (!store?.saveImage) return { text, path };
          const name = path.split('/').at(-1);
          const saved = await store.saveImage({ data: bytes, mediaType: 'image/png', name }).catch(() => null);
          if (!saved?.attachmentId) return { text, path };
          return {
            text, path,
            image: { attachmentId: String(saved.attachmentId), mediaType: saved.mediaType ?? 'image/png', name, bytes: saved.bytes ?? bytes.length, width: saved.width ?? result.width, height: saved.height ?? result.height },
          };
        });
      },
    },
    {
      name: 'no996_face_analysis',
      description: 'Locate up to four faces per sampled frame in project video or images for reframing. Returns normalized 2D boxes and a handful of facial landmarks. No identity, face matching or tracking; does not edit media.',
      parameters: { type: 'object', additionalProperties: false, required: ['source'], properties: { source: parameter, at: { type: 'array', minItems: 1, maxItems: maxSamples, items: seconds, description: 'One to eight source-media seconds (default [0]).' } } },
      output: {
        schema: {
          type: 'object', required: ['text', 'frames'], additionalProperties: false, properties: {
            text: { type: 'string' }, frames: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['at', 'width', 'height', 'faces'], properties: {
              at: { type: 'number' }, width: { type: 'integer' }, height: { type: 'integer' }, faces: { type: 'array', items: faceSchema },
            } } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `${value.text}\n${JSON.stringify(value.frames)}` }],
      },
      timeoutMs: 180_000,
      async execute(args, exec) {
        const times = args?.at ?? [0];
        if (!Array.isArray(times) || !times.length || times.length > maxSamples || !times.every(numericTime)) throw new Error('at 必须包含 1–8 个 0–43200 的素材秒数。');
        return run(args, exec, 'face', [...new Set(times)], async frames => ({
          text: `已分析 ${frames.length} 帧，仅返回位置。坐标范围 [0,1]，左上角为原点，不包含身份或跨帧跟踪。`, frames,
        }));
      },
    },
  ];
}
