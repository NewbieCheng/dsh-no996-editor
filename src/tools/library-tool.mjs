/**
 * `openfilm_library`: OpenFilm's own free library — transitions, effects,
 * filters, stickers, text styles, music, sounds, templates.
 *
 * Two operations, because that is what upstream has:
 *   - search (`POST /api/get/library`) answers with lines of hits and their ids;
 *   - take (`POST /api/get` with `take`) copies one into the project, which is
 *     what makes it usable in film.html.
 * Search deliberately runs without a model: it scores the library by tags, so it
 * answers in milliseconds and costs nothing.
 */
import { searchTemplates, catalogText } from '../film/template-catalog.mjs';

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
    description: 'Search OpenFilm\'s built-in free library (transitions, effects, filters, stickers, text styles, music, sounds, templates) by what you want it to feel like, then take the one you want into the project. Free, offline, no service needed. Use `take` with an id from a previous search to make that item part of the project.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What you are looking for, in words ("柔和的淡入淡出", "energetic drum bed", "手写标题").' },
        kind: { type: 'string', enum: KINDS, description: 'Which part of the library to search (default transition).' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'How many hits (default 8).' },
        take: { type: 'string', description: 'An item id from a previous search: copy it into the project instead of searching.' },
        seconds: { type: 'integer', minimum: 1, maximum: 3600, description: 'Roughly how long it must last (music, sounds).' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }] },
    isConcurrencySafe: () => true,
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
            ? `\n\n已启用为本片模板（当前：${activated.active.join('、')}），它的说明已写进项目 AGENTS.md。`
            : '';
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
        // `take` lands the item in the project; the receipt says what to reference.
        const result = await http().post('/api/get', { body: { folder: project.path, verb: kind, args: { take: text(args.take) } } });
        return { text: `取入项目：${text(result?.text) ?? (result?.ok === true ? '已完成' : '没有说结果')}` };
      }

      const query = text(args?.query);
      if (!query) throw new Error('What to look for is required (or pass take with an id).');
      const limit = Number.isSafeInteger(args?.limit) ? Math.min(20, Math.max(1, args.limit)) : 8;
      const result = await http().post('/api/get/library', {
        body: {
          verb: kind,
          args: { prompt: query, limit, ...(Number.isSafeInteger(args?.seconds) ? { sec: String(args.seconds) } : {}) },
        },
      });
      const lines = Array.isArray(result?.lines) ? result.lines.filter(line => typeof line === 'string') : [];
      if (lines.length === 0) {
        return { text: `库里没有找到「${query}」（${kind}）。可以换个说法，或换一类试试。` };
      }
      return {
        text: `库里找到 ${lines.length} 条（${kind}，免费、离线）：\n${lines.slice(0, MAX_LINES).map(line => line.slice(0, 240)).join('\n')}\n\n想用其中一条：用 openfilm_library 传 take=<那条的 id>。`,
      };
    },
  };
}

/** The verbs this tool accepts, so the controller can describe it once. */
export const LIBRARY_KINDS = Object.freeze([...KINDS]);
