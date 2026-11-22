/**
 * `no996_clip`: change the timeline safely on disk (`move`, `trim`, `split`)
 * OR via Studio's validated `/api/projects/:id/edit` API (`insert`, `preset`, `remove`)
 * so the model can mount wordart (`text/looks/*`), text-motions, fonts, LUT
 * filters (`filters/*`), CSS keyframes (`motions/*`), stickers, effects & audio
 * onto `film.html` without hand-corrupting XML/CSS/overrides.
 */
import { createHash } from 'node:crypto';
import { open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { draftFilm } from '../film/film-draft.mjs';
import { mergeLayerOverride } from '../film/editable-check.mjs';
import { TimelineEditError } from '../film/timeline-operations.mjs';
import {
  buildGradeFilterCss,
  findLibraryItem,
  mergeFadeOverride,
  mergeRootVars,
  mergeTextOverride,
  setStyleDeclaration,
} from '../film/library-presets.mjs';

export const MAX_CLIP_BYTES = 2 * 1024 * 1024;
export const MAX_CLIP_OPERATIONS = 100;
const FILM = 'film.html';

const hashOf = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const show = value => (typeof value === 'number' && Number.isFinite(value) ? value : String(value ?? ''));
const cleanText = value => (typeof value === 'string' && value.trim() ? value.trim() : '');

/** Read the film together with the identity used for conflict detection. */
async function readBaseline(path) {
  const before = await stat(path);
  if (!before.isFile()) throw Object.assign(new Error(`${FILM} is not a regular file`), { code: 'NOT_A_FILE' });
  if (before.size > MAX_CLIP_BYTES) throw Object.assign(new Error(`${FILM} 超过 2 MiB，拒绝读写`), { code: 'TOO_LARGE' });
  const bytes = await readFile(path);
  const after = await stat(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw Object.assign(new Error(`${FILM} 正在被改写，这次没有动它；请重新读一遍再改`), { code: 'CHANGED_WHILE_READING' });
  }
  return { text: bytes.toString('utf8'), hash: hashOf(bytes), mtimeMs: Math.round(after.mtimeMs), size: after.size };
}

/** Write through a sibling temp file, then rename: a reader never sees half a film. */
async function writeAtomic(path, text) {
  const temp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx');
    await handle.writeFile(text, 'utf8');
    await handle.sync().catch(() => undefined);
    await handle.close();
    handle = undefined;
    await rename(temp, path);
  } catch (failure) {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw failure;
  }
}

function findClipInDoc(doc, clipId) {
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  for (let t = 0; t < tracks.length; t++) {
    const track = tracks[t];
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    const clip = clips.find(c => c?.id === clipId);
    if (clip) return { t, track, clip };
  }
  return null;
}

function buildMotionAnimation(motionItem) {
  const keyframes = {};
  const entries = [];
  const def = motionItem?.motion;
  if (!def || typeof def !== 'object') return { keyframes, entries };
  for (const phase of ['in', 'loop', 'out']) {
    const part = def[phase];
    if (!part || typeof part.name !== 'string' || typeof part.body !== 'string') continue;
    keyframes[part.name] = part.body;
    const secs = Number(part.secs) > 0 ? Number(part.secs) : 0.6;
    const ease = cleanText(part.ease) || 'ease';
    const iter = phase === 'loop' ? 'infinite' : '1';
    const fill = phase === 'loop' ? 'none' : 'both';
    entries.push(`${part.name} ${secs}s ${ease} ${iter} ${fill}`);
  }
  return { keyframes, entries };
}

async function resolveLibraryVars(rawId, expectedKind) {
  if (!rawId) return null;
  const hit = await findLibraryItem(rawId);
  if (!hit?.item) throw new Error(`素材库里找不到预设：${rawId}（请先用 no996_library 搜索）。`);
  if (expectedKind && hit.item.kind !== expectedKind) {
    throw new Error(`「${rawId}」类型是 ${hit.item.kind}，不是预期的 ${expectedKind}。`);
  }
  return hit.item;
}

async function applyStudioOperations({ project, operations, expect, dryRun, client }) {
  const baseUrl = `/api/projects/${encodeURIComponent(project.projectId)}`;
  const film = await client.get(baseUrl);
  if (!film?.doc || !Array.isArray(film.doc.tracks)) {
    throw new Error('Studio 未返回有效的影片结构，无法写入高级时间轴操作。');
  }
  const askedRev = cleanText(expect?.revision) || cleanText(expect?.hash);
  if (askedRev && film.rev && askedRev !== film.rev) {
    throw new Error(`影片版本已变化（现在是 ${film.rev}，你传的是 ${askedRev}）；请先用 no996_film 重读再改。`);
  }

  const studioOps = [];
  const notes = [];
  const took = new Map();

  const takeOnce = async path => {
    if (took.has(path)) return took.get(path);
    const taken = await client.post(`${baseUrl}/saved/take`, { body: { path } });
    took.set(path, taken);
    return taken;
  };

  for (const op of operations) {
    if (op.op === 'move') {
      const found = findClipInDoc(film.doc, op.clip);
      if (!found) throw new Error(`片段不存在：${op.clip}`);
      if (found.track?.locked) throw new Error(`轨道 ${found.t} 已锁定，拒绝移动 ${op.clip}。`);
      if (op.track !== undefined && film.doc.tracks[op.track]?.locked) {
        throw new Error(`目标轨道 ${op.track} 已锁定，拒绝移入。`);
      }
      studioOps.push({
        op: 'move',
        clip: op.clip,
        at: op.at ?? 0,
        ...(op.track !== undefined ? { track: op.track } : {}),
      });
      notes.push(`move ${op.clip} -> ${op.at ?? 0}s`);
      continue;
    }

    if (op.op === 'remove') {
      const found = findClipInDoc(film.doc, op.clip);
      if (!found) throw new Error(`片段不存在：${op.clip}`);
      if (found.track?.locked) throw new Error(`轨道 ${found.t} 已锁定，拒绝移除 ${op.clip}。`);
      studioOps.push({ op: 'remove', clip: op.clip });
      notes.push(`remove ${op.clip}`);
      continue;
    }

    if (op.op === 'insert') {
      if (op.track !== undefined && film.doc.tracks[op.track]?.locked) {
        throw new Error(`目标轨道 ${op.track} 已锁定，拒绝插入素材。`);
      }
      let rawSrc = cleanText(op.src);
      if (!rawSrc && (op.wordart || op.textmotion)) rawSrc = 'openfilm/text/text';
      if (!rawSrc && op.filter) rawSrc = op.filter;
      if (!rawSrc) throw new Error('op=insert 必须提供 src（项目内路径或 openfilm/... 库 ID）或 wordart/filter。');

      const clipObj = {};
      let resolvedFilterItem = null;
      let resolvedMotionItem = null;

      if (rawSrc.startsWith('openfilm/')) {
        const hit = await findLibraryItem(rawSrc);
        if (hit?.item?.kind === 'textstyle' || hit?.item?.kind === 'textmotion') {
          const taken = await takeOnce('openfilm/text/text');
          Object.assign(clipObj, taken?.clip || { src: taken?.path || 'saved/openfilm/text-text/text.html' });
          if (hit.item.kind === 'textstyle' && !op.wordart) op = { ...op, wordart: rawSrc };
          if (hit.item.kind === 'textmotion' && !op.textmotion) op = { ...op, textmotion: rawSrc };
        } else if (hit?.item?.kind === 'look') {
          const taken = await takeOnce(rawSrc);
          Object.assign(clipObj, taken?.clip || { src: taken?.path });
          resolvedFilterItem = hit.item;
        } else if (hit?.item?.kind === 'motion') {
          throw new Error(`「${rawSrc}」是关键帧动效而非独立画面片段，请改用 op="preset" 挂载到现有片段。`);
        } else {
          const taken = await takeOnce(rawSrc);
          if (taken?.clip) Object.assign(clipObj, taken.clip);
          else if (taken?.path) clipObj.src = taken.path;
          else throw new Error(`素材「${rawSrc}」取用失败或属于多轨组合模板（可用 no996_library take 展开）。`);
        }
      } else {
        clipObj.src = rawSrc.replaceAll('\\', '/');
      }

      if (!clipObj.src) throw new Error(`无法解析插入片段源路径：${rawSrc}`);
      const dur = Number.isFinite(op.duration) && op.duration > 0 ? op.duration : undefined;
      if (dur !== undefined) clipObj.time = [0, Math.round(dur * 1000) / 1000];
      else if (Number.isFinite(op.start) && Number.isFinite(op.end) && op.end > op.start) {
        clipObj.time = [op.start, op.end];
      }

      let overrides = Array.isArray(clipObj.overrides) ? clipObj.overrides : [];
      const rootVars = {};
      if (op.wordart) {
        const wa = await resolveLibraryVars(op.wordart, 'textstyle');
        Object.assign(rootVars, wa.vars || {});
      }
      if (op.textmotion) {
        const tm = await resolveLibraryVars(op.textmotion, 'textmotion');
        Object.assign(rootVars, tm.vars || {});
      }
      if (cleanText(op.font)) rootVars['--font'] = cleanText(op.font);
      if (dur !== undefined && String(clipObj.src).includes('text-text/text.html')) {
        rootVars['--clip-length'] = `${dur}s`;
      }
      if (Object.keys(rootVars).length) overrides = mergeRootVars(overrides, rootVars);
      if (typeof op.text === 'string') overrides = mergeTextOverride(overrides, op.text, '.t');
      if (Array.isArray(op.fade) && op.fade.length === 2) overrides = mergeFadeOverride(overrides, op.fade);
      if (overrides.length) clipObj.overrides = overrides;

      let style = cleanText(op.style) || cleanText(clipObj.style) || '';
      const filterId = op.filter || (resolvedFilterItem ? `openfilm/${resolvedFilterItem.id}` : '');
      if (filterId) {
        const fItem = resolvedFilterItem || await resolveLibraryVars(filterId, 'look');
        const filterCss = buildGradeFilterCss(filterId, fItem.grade, op.amount ?? 1);
        const propName = String(clipObj.src).includes('filters-') ? 'backdrop-filter' : 'filter';
        style = setStyleDeclaration(style, propName, filterCss);
      }
      if (op.motion) {
        resolvedMotionItem = await resolveLibraryVars(op.motion, 'motion');
        const built = buildMotionAnimation(resolvedMotionItem);
        if (Object.keys(built.keyframes).length) {
          studioOps.push({ op: 'keyframes', set: built.keyframes });
          style = setStyleDeclaration(style, 'animation', built.entries.join(', '));
        }
      }
      if (style) clipObj.style = style;
      if (typeof op.volume === 'number' && Number.isFinite(op.volume) && op.volume >= 0) clipObj.volume = op.volume;
      if (op.box && typeof op.box === 'object') clipObj.box = op.box;

      studioOps.push({
        op: 'insert',
        clip: clipObj,
        ...(op.at !== undefined ? { at: op.at } : {}),
        ...(op.newTrack !== undefined ? { newTrack: op.newTrack } : op.track !== undefined ? { track: op.track } : {}),
      });
      notes.push(`insert ${clipObj.src} @ ${op.at ?? 0}s`);
      continue;
    }

    if (op.op === 'preset') {
      const found = findClipInDoc(film.doc, op.clip);
      if (!found) throw new Error(`片段不存在：${op.clip}`);
      if (found.track?.locked) throw new Error(`轨道 ${found.t} 已锁定，拒绝修改 ${op.clip}。`);
      const existing = found.clip;
      const edits = [];

      let overrides = Array.isArray(existing.overrides) ? existing.overrides : [];
      let overridesChanged = false;
      const rootVars = {};
      if (op.wordart) {
        const wa = await resolveLibraryVars(op.wordart, 'textstyle');
        Object.assign(rootVars, wa.vars || {});
      }
      if (op.textmotion) {
        const tm = await resolveLibraryVars(op.textmotion, 'textmotion');
        Object.assign(rootVars, tm.vars || {});
      }
      if (cleanText(op.font)) rootVars['--font'] = cleanText(op.font);
      if (Object.keys(rootVars).length) {
        overrides = mergeRootVars(overrides, rootVars);
        overridesChanged = true;
      }
      if (typeof op.text === 'string') {
        overrides = mergeTextOverride(overrides, op.text, '.t');
        overridesChanged = true;
      }
      if (overridesChanged) edits.push({ clip: op.clip, prop: 'overrides', value: overrides.length ? overrides : null });
      if (Array.isArray(op.fade) && op.fade.length === 2) edits.push({ clip: op.clip, prop: 'fade', value: op.fade });

      let style = cleanText(op.style) ?? cleanText(existing.style) ?? '';
      let styleChanged = Boolean(cleanText(op.style));
      if (op.filter) {
        const fItem = await resolveLibraryVars(op.filter, 'look');
        const filterCss = buildGradeFilterCss(op.filter, fItem.grade, op.amount ?? 1);
        const propName = String(existing.src || '').includes('filters-') ? 'backdrop-filter' : 'filter';
        style = setStyleDeclaration(style, propName, filterCss);
        styleChanged = true;
      }
      if (op.motion) {
        const mItem = await resolveLibraryVars(op.motion, 'motion');
        const built = buildMotionAnimation(mItem);
        if (Object.keys(built.keyframes).length) {
          studioOps.push({ op: 'keyframes', set: built.keyframes });
          style = setStyleDeclaration(style, 'animation', built.entries.join(', '));
          styleChanged = true;
        }
      }
      if (styleChanged) edits.push({ clip: op.clip, prop: 'style', value: style || null });
      if (typeof op.volume === 'number' && Number.isFinite(op.volume) && op.volume >= 0) {
        edits.push({ clip: op.clip, prop: 'volume', value: op.volume });
      }
      if (op.at !== undefined) edits.push({ clip: op.clip, prop: 'at', value: op.at });
      if (op.box && typeof op.box === 'object') edits.push({ clip: op.clip, prop: 'box', value: op.box });
      if (!edits.length) throw new Error(`op=preset (${op.clip}) 没有提供任何可写入属性。`);

      studioOps.push({ op: 'props', edits });
      notes.push(`preset ${op.clip} (${edits.map(e => e.prop).join(', ')})`);
      continue;
    }

    if (op.op === 'layer') {
      const found = findClipInDoc(film.doc, op.clip);
      if (!found) throw new Error(`片段不存在：${op.clip}`);
      if (found.track?.locked) throw new Error(`轨道 ${found.t} 已锁定，拒绝修改 ${op.clip}。`);
      const selector = cleanText(op.selector)
        || (cleanText(op.elementId) ? `[data-element-id="${cleanText(op.elementId).replace(/"/g, '\\"')}"]` : '');
      if (!selector) throw new Error(`op=layer (${op.clip}) 必须提供稳定的 elementId 或 selector。`);
      const merged = mergeLayerOverride(found.clip.overrides, {
        at: selector,
        n: op.n,
        text: op.text,
        t: op.t,
        s: op.s,
        r: op.r,
        style: op.layerStyle,
      });
      studioOps.push({ op: 'props', edits: [{ clip: op.clip, prop: 'overrides', value: merged }] });
      notes.push(`layer ${op.clip} (${selector})`);
      continue;
    }

    throw new Error(`混合批次暂不支持直接与 ${op.op} 混用；trim/split 请单独调用 no996_clip。`);
  }

  if (dryRun === true) {
    return {
      text: `试算（未保存 Studio 修改）：${notes.join('；')}\n· 当前影片版本: ${film.rev || 'unknown'}`,
    };
  }

  const edited = await client.post(`${baseUrl}/edit`, { body: { base: film.rev, ops: studioOps } });
  if (typeof edited?.rev !== 'string' || edited.rev === film.rev) {
    throw new Error('Studio 未返回可验证的新影片版本；请先用 no996_film 读回检查。');
  }
  return {
    text: `已保存 Studio 编辑：${operations.length} 步（${notes.join('；')}）\n· 新影片版本：${edited.rev}（尚未预览，请用 no996_frame 抽帧核验）`,
  };
}

export function createClipTool({ isProjectAgent, projectOf, http = null }) {
  return {
    name: 'no996_clip',
    description: 'Edit the timeline safely: `move` / `trim` / `split` operate atomically on film.html with baseline hash protection; `insert` / `preset` / `remove` apply wordart (`openfilm/text/looks/*`), textmotion, fonts, LUT color filters (`openfilm/filters/*`), keyframes (`openfilm/motions/*`), effects, stickers & audio directly via Studio `/edit`. Locked tracks and stale revisions are refused.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['operations'],
      properties: {
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CLIP_OPERATIONS,
          description: 'Timeline operations applied atomically.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['op'],
            properties: {
              op: { type: 'string', enum: ['move', 'trim', 'split', 'insert', 'preset', 'remove', 'layer'] },
              clip: { type: 'string', description: 'Target clip id (required for move/trim/split/preset/remove/layer).' },
              elementId: { type: 'string', description: 'layer: stable data-element-id inside a page clip.' },
              selector: { type: 'string', description: 'layer: explicit CSS selector inside the page clip.' },
              n: { type: 'integer', minimum: 1, description: 'layer: optional 1-based element match index.' },
              t: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' }, description: 'layer: [dx, dy] translation override in px.' },
              s: { description: 'layer: scale factor (>0) or [sx, sy] pair.' },
              r: { type: 'number', description: 'layer: rotation override in degrees.' },
              layerStyle: { type: 'object', description: 'layer: CSS properties object (fontSize, color, etc.) merged non-destructively.' },
              src: { type: 'string', description: 'insert: project path ("assets/...", "saved/...") or built-in library ID ("openfilm/...").' },
              at: { type: 'number', minimum: 0, description: 'Timeline start in film seconds.' },
              duration: { type: 'number', minimum: 0.05, maximum: 3600, description: 'insert: clip duration in seconds.' },
              start: { type: 'number', minimum: 0, description: 'trim / insert: source start in seconds.' },
              end: { type: 'number', minimum: 0, description: 'trim / insert: source end in seconds.' },
              track: { type: 'integer', minimum: 0, description: 'move / insert: destination track index.' },
              newTrack: { type: 'integer', minimum: 0, description: 'insert: create a new track at this index (0 = topmost overlay).' },
              rightId: { type: 'string', description: 'split: id for right-hand clip.' },
              text: { type: 'string', description: 'insert / preset: text content written to `.t` override.' },
              font: { type: 'string', description: 'insert / preset: CSS `--font` family stack (inspect with no996_fonts first).' },
              wordart: { type: 'string', description: 'insert / preset: built-in wordart id (e.g. "openfilm/text/looks/gold").' },
              textmotion: { type: 'string', description: 'insert / preset: built-in textmotion id (e.g. "openfilm/text/motions/in-pop").' },
              filter: { type: 'string', description: 'insert / preset: built-in LUT filter id (e.g. "openfilm/filters/warm-film").' },
              amount: { type: 'number', minimum: 0, maximum: 1, description: 'filter strength 0..1 (default 1).' },
              motion: { type: 'string', description: 'insert / preset: built-in CSS keyframe id (e.g. "openfilm/motions/in-zoom").' },
              fade: { type: 'array', items: { type: 'number', minimum: 0 }, description: 'insert / preset: [fadeIn, fadeOut] seconds.' },
              volume: { type: 'number', minimum: 0, maximum: 5, description: 'insert / preset: audio volume multiplier (e.g. 0.25).' },
              style: { type: 'string', description: 'insert / preset: explicit CSS inline declarations.' },
              box: { type: 'object', description: 'insert / preset: stage placement box { x, y, w, h }.' },
            },
          },
        },
        expect: {
          type: 'object',
          additionalProperties: false,
          description: 'Baseline hash (disk edits) or revision (Studio edits).',
          properties: {
            hash: { type: 'string', description: 'sha256 prefix returned by no996_clip.' },
            revision: { type: 'string', description: '16-hex revision returned by no996_film.' },
          },
        },
        dryRun: { type: 'boolean', description: 'Report what would change without saving.' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof isProjectAgent !== 'function' || isProjectAgent(exec?.agent) !== true) {
        throw new Error('This tool is available only to a conversation bound to a No996 Studio project.');
      }
      const project = projectOf?.(exec.agent);
      if (!project?.path) throw new Error('This conversation is not bound to a No996 Studio project.');
      const operations = Array.isArray(args?.operations) ? args.operations : [];
      if (operations.length === 0) throw new Error('At least one operation is required.');
      if (operations.length > MAX_CLIP_OPERATIONS) throw new Error(`At most ${MAX_CLIP_OPERATIONS} operations in one call.`);

      const usesStudioOps = operations.some(op => op && ['insert', 'preset', 'remove', 'layer'].includes(op.op));
      if (usesStudioOps) {
        if (typeof http !== 'function') {
          throw new Error('insert / preset / remove 操作需要 Studio 服务连接（未提供 http 客户端）。');
        }
        return applyStudioOperations({
          project,
          operations,
          expect: args?.expect,
          dryRun: args?.dryRun === true,
          client: http(),
        });
      }

      const path = join(project.path, FILM);
      let baseline;
      try {
        baseline = await readBaseline(path);
      } catch (failure) {
        if (failure?.code === 'ENOENT') throw new Error(`这个项目还没有 ${FILM}；先在 Studio 里建一个空草稿再改。`);
        throw new Error(String(failure?.message || failure));
      }

      const asked = typeof args?.expect?.hash === 'string' ? args.expect.hash.trim() : '';
      if (asked && asked !== baseline.hash) {
        throw new Error(`没有动文件：${FILM} 已经变了（现在是 ${baseline.hash}，你手上是 ${asked}）。重新读一遍，再按新的内容改。`);
      }

      let drafted;
      try {
        drafted = draftFilm({ source: baseline.text, operations });
      } catch (failure) {
        if (failure instanceof TimelineEditError) {
          throw new Error(`没有改动：${failure.kind === 'conflict' ? '冲突' : '这个编辑不成立'}——${failure.message}`);
        }
        throw new Error(`没有改动：${String(failure?.message || failure)}`);
      }

      if (drafted.text === baseline.text) return { text: '这几步操作没有改变影片（结果与原来一致），文件没动。' };

      const nextHash = hashOf(Buffer.from(drafted.text, 'utf8'));
      const bytesDelta = Buffer.byteLength(drafted.text, 'utf8') - baseline.size;
      const report = [
        `已${args?.dryRun === true ? '试算（未保存）' : '保存'}：${operations.length} 步`,
        `· 变化：${bytesDelta >= 0 ? '+' : ''}${bytesDelta} 字节`,
        `· 新基线：${args?.dryRun === true ? baseline.hash : nextHash}`,
      ];
      if (args?.dryRun === true) {
        return { text: `${report.join('\n')}\n（试算没有写盘；确定要保存就去掉 dryRun，并带上 expect.hash = ${baseline.hash}）` };
      }

      const again = await readFile(path).catch(() => null);
      if (!again || hashOf(again) !== baseline.hash) {
        throw new Error(`没有保存：${FILM} 在我准备写入的过程中被改动了。重新读一遍再改。`);
      }
      try {
        await writeAtomic(path, drafted.text);
      } catch (failure) {
        throw new Error(`保存失败：${String(failure?.message || failure)}`);
      }
      return { text: `${report.join('\n')}\n· 结构：${drafted.summary ? String(drafted.summary).slice(0, 600) : '已更新'}` };
    },
  };
}

/** Exported for tests: the conflict identity of a film file. */
export async function filmIdentity(path) {
  const bytes = await readFile(path);
  return { hash: hashOf(bytes), size: bytes.byteLength, show };
}
