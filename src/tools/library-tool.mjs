/**
 * `no996_library`: unified media, wordart, text-motion, filter, effect, transition,
 * sticker, layer, music, sound & template catalog tool.
 *
 * Supports:
 * - searching all 13 library kinds (including `wordart` 41 flower-text styles,
 *   `textmotion` 31 text animations, `motion` 64 clip keyframes, `filter` 67 grades,
 *   `layer` 5 shapes, `template` = No996 continuous templates + 14 OpenFilm templates)
 * - read-only `inspect` to extract full CSS `--font`/`--fill`/`--stroke`/`--glow` vars,
 *   filter LUT matrices, `@keyframes`, or multi-track template blueprints for design reference
 * - `take` (+ optional `cut` transition placement) into the bound project.
 */
import { searchTemplates, catalogText } from '../film/template-catalog.mjs';
import { planLibraryTransition } from '../film/library-transition.mjs';
import { findLibraryItem, inspectLibraryItem } from '../film/library-presets.mjs';
import { AGENT_VERBS, searchBuiltInLibrary, searchBuiltInTemplates } from './library-search.mjs';

const KINDS = [
  'transition', 'effect', 'filter', 'sticker', 'text',
  'wordart', 'textmotion', 'motion', 'layer',
  'template', 'music', 'sound', 'sfx',
];
const MAX_LINES = 45;

const text = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);

function normaliseKind(value) {
  const kind = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (kind === 'sfx') return 'sound';
  return KINDS.includes(kind) ? kind : 'transition';
}

function formatBuiltInTemplates(items) {
  if (!items.length) return '';
  return items.map(item => {
    const zh = item.name?.['zh-CN'] ?? item.name?.zh;
    const title = item.name?.en ? `${item.name.en}${zh ? ` (${zh})` : ''}` : (zh || item.id);
    const dur = item.durationMs ? `${Math.round(item.durationMs / 100) / 10}s` : '';
    const slots = item.slots ? `${item.slots} 槽位` : '';
    const meta = [dur, slots].filter(Boolean).join(' · ');
    return `· openfilm/${item.id} —— ${title}${meta ? ` [${meta}]` : ''}${item.about ? `：${item.about}` : ''}`;
  }).join('\n');
}

export function createLibraryTool({ isProjectAgent, projectOf, http, templates = null, activateTemplate = null }) {
  return {
    name: 'no996_library',
    description: 'Search, inspect recipes, or take built-in assets & templates: wordart (41 flower-text styles), textmotion, text templates, filter (67 color grades), effect, motion (keyframes), transition, sticker, layer, template (No996 continuous stage + 14 multi-track templates), music & sound. Pass inspect="<id>" to read full CSS vars, LUT grade, @keyframes, or multi-track blueprint as design reference without editing the project; pass take="<id>" to copy into the project.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What to look for ("鎏金花字", "霓虹", "胶片暖", "柔和的淡入淡出", "手绘箭头", "科普").' },
        kind: { type: 'string', enum: KINDS, description: 'Library category (default transition). Use wordart for flower-text styles, filter for LUT grades, motion for CSS keyframes.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max hits (default 8).' },
        inspect: { type: 'string', description: 'Read-only: inspect a library item id ("openfilm/text/looks/gold", "openfilm/filters/warm-film", "openfilm/templates/travel-vlog", or a No996 template id) to get full CSS vars / keyframes / structure as design reference or clip preset.' },
        take: { type: 'string', description: 'An item id from search: copy/activate into the project (or take base text component for wordart/textmotion).' },
        readTemplate: { type: 'string', description: 'Read a No996 or built-in template’s guidance without changing the project.' },
        seconds: { type: 'integer', minimum: 1, maximum: 3600, description: 'Roughly how long it must last (music, sounds).' },
        cut: {
          type: 'object',
          additionalProperties: false,
          required: ['before', 'after', 'revision', 'saved'],
          description: 'Optional: place a built-in page transition at a verified cut. Save Studio work first; use the revision from no996_film. Requires two adjacent clips on one ordinary track.',
          properties: {
            before: { type: 'string', description: 'Outgoing clip ID.' },
            after: { type: 'string', description: 'Incoming clip ID.' },
            revision: { type: 'string', description: 'Revision returned by no996_film.' },
            saved: { type: 'boolean', description: 'True only when current Studio changes are saved.' },
          },
        },
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
      if (!project?.projectId || !project.path) throw new Error('This conversation is not bound to a No996 Studio project.');
      const kind = normaliseKind(args?.kind);

      const inspectId = text(args?.inspect);
      if (inspectId) {
        if (!inspectId.startsWith('openfilm/') && typeof templates === 'function') {
          const catalog = await templates().catch(() => []);
          const chosen = catalog.find(item => item.id === inspectId);
          if (chosen) {
            return { text: `【不加班模板 ${chosen.id} —— ${chosen.title}】${chosen.description ? `\n${chosen.description}` : ''}\n\n${chosen.prompt || '（按模板 film.html 结构与连续生长准则继续。）'}\n\n只读取了说明，没有改动项目。` };
          }
        }
        const found = await findLibraryItem(inspectId);
        if (found) {
          return { text: inspectLibraryItem(found.item, { builtInRoot: found.builtInRoot }) };
        }
        const libFallback = await http().get('/api/library').catch(() => null);
        const fallbackHit = await findLibraryItem(inspectId, libFallback?.items);
        if (fallbackHit) {
          return { text: inspectLibraryItem(fallbackHit.item) };
        }
        throw new Error(`素材库里没有找到「${inspectId}」；请先用 no996_library(query=...) 搜出 ID。`);
      }

      if (kind === 'template') {
        const take = text(args?.take);
        const read = text(args?.readTemplate);
        if (read && take) throw new Error('读取和启用模板是不同操作，请分别调用。');
        const catalog = typeof templates === 'function' ? await templates().catch(() => []) : [];
        if (read) {
          const chosen = catalog.find(item => item.id === read);
          if (chosen) {
            return { text: `模板 ${chosen.id} —— ${chosen.title}${chosen.description ? `：${chosen.description}` : ''}\n\n${chosen.prompt || '（这个模板没有额外说明；按它的 film.html 版式继续。）'}\n\n只读取了说明，没有改动项目。` };
          }
          const builtIn = await findLibraryItem(read);
          if (builtIn) return { text: inspectLibraryItem(builtIn.item, { builtInRoot: builtIn.builtInRoot }) };
          throw new Error(`没有这个模板：${read}（先搜一次拿 id）。`);
        }
        if (take && !take.startsWith('openfilm/')) {
          const chosen = catalog.find(item => item.id === take);
          if (!chosen) throw new Error(`没有这个模板：${take}（先搜一次拿 id）。`);
          let activated = null;
          if (typeof activateTemplate === 'function') {
            try { activated = await activateTemplate(project.path, chosen.id); } catch { activated = null; }
          }
          const where = activated?.active?.length
            ? `\n\n已启用为本片模板（当前：${activated.active.join('、')}）。${activated.instructionSync === 'user-owned' || activated.instructionSync === 'missing' || activated.instructionSync === 'unreadable' ? '项目指令文件未改动；后续需要时请再次读取该模板说明。' : '模板说明已同步到插件管理的项目指令。'}`
            : '\n\n模板激活未确认；以上仅是说明。';
          return { text: `模板 ${chosen.id} —— ${chosen.title}${chosen.description ? `：${chosen.description}` : ''}\n\n${chosen.prompt || '（这个模板没有额外说明；按它的 film.html 版式继续。）'}${where}` };
        }
        if (!take) {
          const query = text(args?.query) ?? '';
          const limit = Math.min(12, Math.max(1, Number(args?.limit) || 6));
          const no996Hits = catalog.length ? searchTemplates(catalog, query, limit) : [];
          const builtInHits = await searchBuiltInTemplates(query, limit);
          const blocks = [];
          if (catalog.length) {
            const listText = no996Hits.length ? catalogText(no996Hits) : catalogText(catalog);
            blocks.push(`【不加班高阶动效模板（推荐连续舞台）】\n${listText}\n· 启用并读取指南：no996_library(kind="template", take="<id>")`);
          }
          if (builtInHits.length) {
            blocks.push(`【内置多轨结构模板（${builtInHits.length} 个，可 inspect 看编排或 take 复用）】\n${formatBuiltInTemplates(builtInHits)}`);
          }
          if (!blocks.length) return { text: `没有匹配「${query}」的模板。` };
          return { text: blocks.join('\n\n') };
        }
      }

      if (text(args?.take)) {
        const id = text(args.take);
        if (!/^openfilm\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(id) || id.split('/').some(part => part === '.' || part === '..')) {
          throw new Error('请使用本次搜索返回的 openfilm/ 素材 ID。');
        }
        const base = `/api/projects/${encodeURIComponent(project.projectId)}`;
        const meta = await findLibraryItem(id);

        if (meta?.item?.kind === 'motion') {
          return {
            text: `「${id}」属于纯 CSS 关键帧动效（无需复制文件，离线可用）。请用 no996_clip 直接套用到目标片段：\n`
              + `no996_clip(operations=[{ op: "preset", clip: "<clipId>", motion: "${id}" }])\n\n`
              + inspectLibraryItem(meta.item, { builtInRoot: meta.builtInRoot }),
          };
        }

        if (meta?.item?.kind === 'textstyle' || meta?.item?.kind === 'textmotion') {
          const takenBase = await http().post(`${base}/saved/take`, { body: { path: 'openfilm/text/text' } });
          const landedSrc = text(takenBase?.clip?.src) ?? text(takenBase?.path) ?? 'saved/openfilm/text-text/text.html';
          const flag = meta.item.kind === 'textstyle' ? 'wordart' : 'textmotion';
          return {
            text: `已将文字组件基准包取入项目 (${landedSrc})。\n`
              + `· 请用 no996_clip 一键应用本花字/字效到时间轴：\n`
              + `  no996_clip(operations=[{ op: "insert", src: "openfilm/text/text", ${flag}: "${id}", text: "标题文字", at: 0, duration: 3, newTrack: 0 }])\n\n`
              + inspectLibraryItem(meta.item, { builtInRoot: meta.builtInRoot }),
          };
        }

        let film, item;
        if (args.cut !== undefined) {
          if (kind !== 'transition' || args.cut?.saved !== true || typeof args.cut?.before !== 'string' || typeof args.cut?.after !== 'string' || !/^[a-f0-9]{16}$/.test(args.cut?.revision ?? '')) {
            throw new Error('自动放转场需要两个片段 ID、影片 revision 和已保存 Studio 工作的确认。');
          }
          film = await http().get(base);
          if (film?.rev !== args.cut.revision) throw new Error('影片版本已变化，请重新读取影片后再放置转场。');
          const library = await http().get('/api/library');
          item = Array.isArray(library?.items) ? library.items.find(entry => entry?.id === id.slice('openfilm/'.length)) : undefined;
          if (!item || item.cat !== 'transition' || item.kind !== 'page' || item.place !== 'cut') throw new Error('此素材不是可自动放置的内置页面转场。');
          planLibraryTransition({ film, item, clip: { src: 'saved/openfilm/check/transition.html' }, before: args.cut.before, after: args.cut.after, expect: args.cut.revision });
        }
        const endpoint = `${base}/saved/take`;
        let result;
        try {
          result = await http().post(endpoint, { body: { path: id } });
        } catch (err) {
          const isCloudAudio = id.startsWith('openfilm/audio/') || id.startsWith('openfilm/stickers/emoji/') || id.startsWith('openfilm/community/');
          if (isCloudAudio) {
            throw new Error(`在线素材取用失败（${id} 首次需从 openfilm.dev/library 联网下载缓存）：${String(err?.message || err)}。可改用内置本地音效/Vibe BGM（no996_sfx / no996_audio bgm-install）或本地免联网花字/滤镜/特效/动态贴纸。`);
          }
          throw err;
        }
        const usableClip = clip => clip && typeof clip === 'object' && Boolean(text(clip.src));
        const usable = result && typeof result === 'object' && (
          Boolean(text(result.path)) || usableClip(result.clip) ||
          (Array.isArray(result.clips) && result.clips.length > 0 && result.clips.every(entry => usableClip(entry?.clip)))
        );
        if (!usable) throw new Error('素材取用未返回可用结果；非组件包参数型素材可先用 inspect= 读取配方再由 no996_clip 应用。');
        if (args.cut !== undefined) {
          const plan = planLibraryTransition({ film, item, clip: result.clip, before: args.cut.before, after: args.cut.after, expect: args.cut.revision });
          let edited;
          try {
            edited = await http().post(`${base}/edit`, { body: { base: film.rev, ops: plan.ops } });
          } catch (failure) {
            throw new Error(`转场放置未确认；不要直接重试，请先读回影片检查。素材可能已取入项目：${String(failure?.message || failure)}`);
          }
          if (typeof edited?.rev !== 'string' || edited.rev === film.rev || !Array.isArray(edited?.doc?.tracks)) {
            throw new Error('Studio 未返回可验证的新影片版本；请先读回影片检查，不要直接重试。');
          }
          const previousIds = new Set(film.doc.tracks.flatMap(track => Array.isArray(track?.clips) ? track.clips.map(clip => clip?.id) : []));
          const firstTrack = edited.doc.tracks[0];
          const placed = (Array.isArray(firstTrack?.clips) ? firstTrack.clips : []).find(candidate =>
            typeof candidate?.id === 'string' && candidate.id && !previousIds.has(candidate.id) &&
            candidate.src === result.clip.src && Math.abs((candidate.at ?? 0) - (plan.cut - plan.duration / 2)) < 0.002 &&
            Array.isArray(candidate.time) && candidate.time.length === 2 && candidate.time[0] === 0 && Math.abs(candidate.time[1] - plan.duration) < 0.002);
          if (!placed) throw new Error('Studio 返回了编辑结果但未找到新增的目标转场；请读回影片检查，不要直接重试。');
          return { text: `转场已放入切点 ${plan.cut} 秒（时长 ${plan.duration} 秒，片段 ${placed.id ?? '未命名'}，新版本 ${edited.rev}）；尚未预览，请抽帧检查。` };
        }
        return { text: `素材已取入项目（尚未放入时间轴）：\n${JSON.stringify(result)}\n下一步可直接用 no996_clip(operations=[{ op: "insert", ... }]) 放到目标轨道。` };
      }

      const query = text(args?.query);
      if (!query) throw new Error('What to look for is required (or pass inspect/take with an id).');
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(20, Math.max(1, args.limit)) : 8;
      const verb = AGENT_VERBS[kind];
      const result = verb
        ? await http().post('/api/get/library', {
          body: {
            verb,
            args: { prompt: query, limit: String(limit), ...((kind === 'music' || kind === 'sound') && Number.isSafeInteger(args?.seconds) ? { sec: String(args.seconds) } : {}) },
          },
        })
        : await searchBuiltInLibrary(kind, query, { limit });
      const lines = Array.isArray(result?.lines) ? result.lines.filter(line => typeof line === 'string') : [];
      if (result?.code !== 0) throw new Error(`素材库搜索失败：${lines.join(' ').slice(0, 500) || '无有效回执'}`);
      if (lines.length === 0) {
        return { text: `库里没有找到「${query}」（${kind}）。可以换个说法，或换一类试试。` };
      }
      const note = (kind === 'music' || kind === 'sound' || kind === 'sticker')
        ? '\n\n取用时传 take=<openfilm/ ID>；注意云端曲库/Emoji 首次取用需联网下载至 ~/.openfilm/library，断网时可选用本地音效/内置 Vibe BGM/动态 SVG 贴纸。'
        : '\n\n可用 inspect="<openfilm/ ID>" 读取完整 CSS/LUT/关键帧配方作设计参考，或传 take / no996_clip 应用到时间轴（均纯本地免联网）。';
      return {
        text: `素材库搜索结果（${kind}）：\n${lines.slice(0, MAX_LINES).map(line => line.slice(0, 240)).join('\n')}${note}`,
      };
    },
  };
}

/** The verbs this tool accepts, so the controller can describe it once. */
export const LIBRARY_KINDS = Object.freeze([...KINDS]);
