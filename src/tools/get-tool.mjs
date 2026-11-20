/**
 * `no996_get`: media made by a service the person connected — voice-over,
 * music, sound effects, transcripts, pictures, video, translation.
 *
 * Upstream owns the policy here and this tool must not second-guess it:
 *   - nothing connected → upstream answers with the list of what makes it and
 *     where the person connects one. That is an answer for the model, not an
 *     error: the model should tell the person, not retry.
 *   - a video clip spends real money → upstream asks the person in Studio first
 *     and only runs with `yes` when no page can ask. The model may pass `yes`
 *     only when the person said to.
 * Every receipt is upstream's own text; this tool never invents success.
 */
const MAX_VERBS = 24;
const MAX_TEXT = 4000;
const RATIOS = ['16:9', '9:16', '3:2', '2:3', '4:3', '3:4', '1:1', '21:9'];
const SIZES = ['1k', '2k', '4k'];
const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max'];

const text = value => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
const textList = value => {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
};

export function createGetTool({ isProjectAgent, projectOf, http, prepareVoice }) {
  return {
    name: 'no996_get',
    description: 'Make media for this film with the unified service connected in Studio (Settings → Services, e.g. 不加班 workbench): voice-over (tts), voices (voice), images (image, including cover/keyframe generation with optional ratio/size/quality/ref), music, sound effects, transcripts, video, subtitle translation. Check `list: true` first to see what is connected here. If nothing is connected it says so — tell the person where to connect it instead of retrying. Video clips cost money: only pass yes when the person told you to spend.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        verb: { type: 'string', description: 'What to make (tts, voice, image, music, sfx, asr, image-search, video, translate, cutout, web-search …).' },
        prompt: { type: 'string', description: 'What it should be or say.' },
        out: { type: 'string', description: 'Output base file name without directory or extension (e.g. hero_cover).' },
        ratio: { type: 'string', enum: RATIOS, description: 'Aspect ratio for image/video generation (e.g. 16:9, 9:16, 3:2, 1:1).' },
        size: { type: 'string', enum: SIZES, description: 'Image output resolution tier (1k, 2k, 4k).' },
        quality: { type: 'string', enum: QUALITIES, description: 'Image generation quality tier (low, medium, high, xhigh, max).' },
        ref: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Optional project-relative reference image path(s) for image editing or cover variations.',
        },
        seconds: { type: 'integer', minimum: 1, maximum: 3600, description: 'How long, for audio or video.' },
        take: { type: 'string', description: 'For some verbs: an existing item id to bring in instead of generating.' },
        via: { type: 'string', description: 'Optional provider override (leave unset to use the service selected in Studio Settings → Services).' },
        model: { type: 'string', description: 'Optional model override within the chosen provider.' },
        list: { type: 'boolean', description: 'Only report what can be got here now, and what is not connected.' },
        yes: { type: 'boolean', description: 'Confirm spending without asking in Studio. Only when the person said to.' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof isProjectAgent !== 'function' || isProjectAgent(exec?.agent) !== true) {
        throw new Error('This tool is available only to a conversation bound to an OpenFilm project.');
      }
      const project = projectOf?.(exec.agent);
      if (!project?.projectId || !project.path) throw new Error('This conversation is not bound to an OpenFilm project.');

      if (args?.list === true) {
        await prepareVoice?.();
        const catalog = await http().get('/api/get');
        const verbs = Array.isArray(catalog?.verbs) ? catalog.verbs : [];
        const listing = verbs.slice(0, MAX_VERBS).map(entry => {
          const verb = text(entry?.verb) ?? '?';
          const help = text(entry?.help) ?? '';
          return `${verb}${help ? ` — ${help.slice(0, 160)}` : ''}`;
        });
        const note = text(catalog?.note);
        return {
          text: [
            verbs.length > 0 ? `这台机器现在能做的：\n${listing.join('\n')}` : '这台机器现在没有连接任何生成服务。',
            note ? `\n说明：${note.slice(0, 1200)}` : '',
          ].join('').slice(0, MAX_TEXT),
        };
      }

      const verb = text(args?.verb);
      if (!verb) throw new Error('A verb is required (or list: true to see what is possible).');
      if (verb === 'tts' || verb === 'voice') await prepareVoice?.();
      const refs = textList(args?.ref);
      const result = await http().post('/api/get', {
        body: {
          folder: project.path,
          verb,
          args: {
            ...(text(args?.prompt) ? { prompt: text(args.prompt) } : {}),
            ...(text(args?.out) ? { out: text(args.out) } : {}),
            ...(text(args?.ratio) ? { ratio: text(args.ratio) } : {}),
            ...(text(args?.size) ? { size: text(args.size) } : {}),
            ...(text(args?.quality) ? { quality: text(args.quality) } : {}),
            ...(refs.length === 1 ? { ref: refs[0] } : refs.length > 1 ? { ref: refs } : {}),
            ...(Number.isSafeInteger(args?.seconds) ? { sec: String(args.seconds) } : {}),
            ...(text(args?.take) ? { take: text(args.take) } : {}),
          },
          ...(text(args?.via) ? { via: text(args.via) } : {}),
          ...(text(args?.model) ? { model: text(args.model) } : {}),
          ...(args?.yes === true ? { yes: true } : {}),
        },
      });
      const said = text(result?.text) ?? '';
      if (result?.ok === true) return { text: said ? `完成：${said}`.slice(0, MAX_TEXT) : `${verb} 已完成（Studio 没给更多说明）。` };
      // Not a tool failure: upstream explained why, and the model should relay it.
      const reason = text(result?.reason);
      return {
        text: [
          `${verb} 没有做成${reason === 'balance' ? '（服务账户余额不足）' : ''}。`,
          said || 'Studio 没有说明原因。',
          reason === 'balance' ? '需要人去 Studio 的 Services 里充值，这里不要重试。' : '按上面的说明处理，不要原样重试。',
        ].join(' ').slice(0, MAX_TEXT),
      };
    },
  };
}
