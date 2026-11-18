/**
 * `openfilm_library`: OpenFilm's own free library — transitions, effects,
 * filters, stickers, text styles, music, sounds, templates.
 *
 * Search uses Studio's library search; take uses the project's saved/take route.
 * Taking an asset does not place it on the timeline. Some presets require Studio's
 * UI and music or sound files may need a first-use network download.
 */
import { searchTemplates, catalogText } from '../film/template-catalog.mjs';
import { planLibraryTransition } from '../film/library-transition.mjs';
import { AGENT_VERBS, searchBuiltInLibrary } from './library-search.mjs';

const KINDS = ['transition', 'effect', 'filter', 'sticker', 'text', 'template', 'music', 'sound', 'sfx'];
const MAX_LINES = 40;

const text = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);

function normaliseKind(value) {
  const kind = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (kind === 'sfx') return 'sound';
  return KINDS.includes(kind) ? kind : 'transition';
}

export function createLibraryTool({ isProjectAgent, projectOf, http, templates = null, activateTemplate = null }) {
  return {
    name: 'openfilm_library',
    description: 'Search OpenFilm’s built-in library or take a search result into this project. Taking alone does not place it on the timeline. A page transition can optionally be placed at a verified cut with cut, after Studio work is saved. Some presets need Studio and music or sound may need a first-use download. Template searches use No996 templates.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What you are looking for, in words ("柔和的淡入淡出", "energetic drum bed", "手写标题").' },
        kind: { type: 'string', enum: KINDS, description: 'Which part of the library to search (default transition).' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many hits (default 8).' },
        take: { type: 'string', description: 'An item id from a previous search: copy it into the project instead of searching.' },
        readTemplate: { type: 'string', description: 'Read a template’s guidance without activating it or changing the project (kind=template).' },
        seconds: { type: 'integer', minimum: 1, maximum: 3600, description: 'Roughly how long it must last (music, sounds).' },
        cut: {
          type: 'object', additionalProperties: false, required: ['before', 'after', 'revision', 'saved'],
          description: 'Optional: place a built-in page transition at a verified cut. Save Studio work first; use the revision from openfilm_film. Requires two adjacent clips on one ordinary track.',
          properties: {
            before: { type: 'string', description: 'Outgoing clip ID.' },
            after: { type: 'string', description: 'Incoming clip ID.' },
            revision: { type: 'string', description: 'Revision returned by openfilm_film.' },
            saved: { type: 'boolean', description: 'True only when current Studio changes are saved.' },
          },
        },
      },
    },
    output: { schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }] },
    // Taking copies project files and may edit its timeline.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof isProjectAgent !== 'function' || isProjectAgent(exec?.agent) !== true) {
        throw new Error('This tool is available only to a conversation bound to an OpenFilm project.');
      }
      const project = projectOf?.(exec.agent);
      if (!project?.projectId || !project.path) throw new Error('This conversation is not bound to an OpenFilm project.');
      const kind = normaliseKind(args?.kind);

      // Templates are this Host's own catalog (vendor/templates), not Studio's
      // library: the agent can see what the app can make without opening Studio.
      if (kind === 'template' && typeof templates === 'function') {
        const take = text(args?.take);
        const catalog = await templates().catch(() => []);
        const read = text(args?.readTemplate);
        if (read && take) throw new Error('读取和启用模板是不同操作，请分别调用。');
        if (read) {
          const chosen = catalog.find(item => item.id === read);
          if (!chosen) throw new Error(`没有这个模板：${read}（先搜一次拿 id）。`);
          return { text: `模板 ${chosen.id} —— ${chosen.title}${chosen.description ? `：${chosen.description}` : ''}\n\n${chosen.prompt || '（这个模板没有额外说明；按它的 film.html 版式继续。）'}\n\n只读取了说明，没有改动项目。` };
        }
        if (take) {
          const chosen = catalog.find(item => item.id === take);
          if (!chosen) throw new Error(`没有这个模板：${take}（先搜一次拿 id）。`);
          // Taking a template is choosing this film's point of view: it becomes the
          // project's active template and its prompt goes into the project's
          // AGENTS.md, so later turns keep it (see src/template-prompts.mjs). The text
          // comes back here too, because DSH re-reads instructions on filesystem
          // activity rather than on this write.
          let activated = null;
          if (typeof activateTemplate === 'function') {
            try { activated = await activateTemplate(project.path, chosen.id); } catch { activated = null; }
          }
          const where = activated?.active?.length
            ? `\n\n已启用为本片模板（当前：${activated.active.join('、')}）。${activated.instructionSync === 'user-owned' || activated.instructionSync === 'missing' || activated.instructionSync === 'unreadable' ? '项目指令文件未改动；后续需要时请再次读取该模板说明。' : '模板说明已同步到插件管理的项目指令。'}`
            : '\n\n模板激活未确认；以上仅是说明。';
          return { text: `模板 ${chosen.id} —— ${chosen.title}${chosen.description ? `：${chosen.description}` : ''}\n\n${chosen.prompt || '（这个模板没有额外说明；按它的 film.html 版式继续。）'}${where}` };
        }
        const query = text(args?.query) ?? '';
        const hits = searchTemplates(catalog, query, Math.min(8, Math.max(1, Number(args?.limit) || 5)));
        if (hits.length === 0) return { text: `没有匹配「${query}」的模板。现有模板：\n${catalogText(catalog)}` };
        return {
          text: `模板 ${hits.length} 个：\n${catalogText(hits)}\n\n选中一个：用 openfilm_library 传 take=<id>，会返回这个模板的使用说明（不要整份复制进 film.html）。`,
        };
      }

      if (text(args?.take)) {
        const id = text(args.take);
        if (!/^openfilm\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/.test(id) || id.split('/').some(part => part === '.' || part === '..')) {
          throw new Error('请使用本次搜索返回的 openfilm/ 素材 ID。');
        }
        const base = `/api/projects/${encodeURIComponent(project.projectId)}`;
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
          // Check the cut before copying anything into the project. Validate again
          // against the actual returned clip before submitting the guarded edit.
          planLibraryTransition({ film, item, clip: { src: 'saved/openfilm/check/transition.html' }, before: args.cut.before, after: args.cut.after, expect: args.cut.revision });
        }
        const endpoint = `${base}/saved/take`;
        const result = await http().post(endpoint, { body: { path: id } });
        const usableClip = clip => clip && typeof clip === 'object' && Boolean(text(clip.src));
        const usable = result && typeof result === 'object' && (
          Boolean(text(result.path)) || usableClip(result.clip) ||
          (Array.isArray(result.clips) && result.clips.length > 0 && result.clips.every(entry => usableClip(entry?.clip)))
        );
        if (!usable) throw new Error('素材取用未返回可用结果；预设类素材可能需要在 Studio 素材库中应用。');
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
        return { text: `素材已取入项目（尚未放入时间轴）：\n${JSON.stringify(result)}\n请依据返回的路径或片段信息检查后应用。` };
      }

      const query = text(args?.query);
      if (!query) throw new Error('What to look for is required (or pass take with an id).');
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(20, Math.max(1, args.limit)) : 8;
      // OpenFilm 0.4.0 answers only music, sounds and stickers through the Studio
      // route. The other kinds (transitions, effects, filters, texts) are still
      // searched by the Host itself, with the pinned library's own scoring, so an
      // agent can still find one and put it over a cut.
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
      return {
        text: `素材库搜索结果（${kind}）：\n${lines.slice(0, MAX_LINES).map(line => line.slice(0, 240)).join('\n')}\n\n取用时传 take=<搜索结果中的 openfilm/ ID>；音频首次取用可能需要网络。`,
      };
    },
  };
}

/** The verbs this tool accepts, so the controller can describe it once. */
export const LIBRARY_KINDS = Object.freeze([...KINDS]);
