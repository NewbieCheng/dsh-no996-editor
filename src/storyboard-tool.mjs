import { readStoryboard, normalizeStoryboard, planFromStoryboard, storyboardSummary, validateStoryboard, writeStoryboard, MOTIONS, KINDS } from './storyboard.mjs';
import { planFromTranscript, storyboardFromPlan, subtitlesFromScript, toSrt, sentencesFromSegments } from './script-plan.mjs';
import { readFileSync } from 'node:fs';

const MAX_SHOTS = 200;

const shotSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'from', 'to'],
  properties: {
    id: { type: 'string', description: '镜头 id，例如 s1。' },
    clip: { type: 'string', description: '时间轴上已有片段的 id；有它 plan 才能直接给出操作。' },
    from: { type: 'number', minimum: 0, description: '在成片上的开始秒。' },
    to: { type: 'number', minimum: 0, description: '在成片上的结束秒。' },
    source: { type: 'string', description: '素材路径（项目内相对路径）。' },
    in: { type: 'number', minimum: 0, description: '素材内的开始秒。' },
    out: { type: 'number', minimum: 0, description: '素材内的结束秒。' },
    kind: { type: 'string', enum: KINDS, description: '镜头类型。' },
    motion: { type: 'string', enum: MOTIONS, description: '动作（词汇表见 openfilm-motion）。' },
    caption: { type: 'string', description: '屏上字，≤ 40 字。' },
    transition: { type: 'string', description: '与下一镜的转场。' },
    notes: { type: 'string', description: '给下一轮看的备注。' },
  },
};

/**
 * The storyboard as a tool: plan before cutting, and let the plan be reviewed.
 *
 * `plan` is the honest half of "apply": openfilm_clip can move, trim and split, but it
 * cannot add a clip, so a shot with no clip comes back as `missing` with what it needs,
 * and the existing clips come back as the operations that make them match the plan.
 */
export function createStoryboardTool({ isProjectAgent, projectOf }) {
  return {
    name: 'openfilm_storyboard',
    description: 'Read or write the project\'s storyboard (.film/storyboard.json): the shot list with film seconds, source ranges, motion names and on-screen text. Use it to plan before cutting, and again to keep the timeline matching the plan. "from-script" builds shots from a transcript produced by openfilm_transcribe (sentence boundaries, no cuts mid-sentence); "subtitles" returns SRT text for those sentences. "plan" turns the storyboard into openfilm_clip operations for clips that already exist and names the shots that still need one.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['op'],
      properties: {
        op: { type: 'string', enum: ['read', 'write', 'plan', 'from-script', 'subtitles'], description: 'read/write the storyboard, derive clips, or build it from a transcript.' },
        storyboard: {
          type: 'object', additionalProperties: false,
          description: 'op=write: the whole storyboard. Replaces the file.',
          properties: {
            title: { type: 'string' },
            brief: { type: 'string' },
            style: { type: 'string' },
            duration: { type: 'number' },
            shots: { type: 'array', maxItems: MAX_SHOTS, items: shotSchema },
          },
        },
        transcriptPath: { type: 'string', description: 'op=from-script: the JSON file openfilm_transcribe wrote (its transcriptPath).' },
        clips: {
          type: 'array', maxItems: 200,
          description: 'op=plan: the clips that exist now (id/from/to/start/end/track), e.g. from openfilm_film.',
          items: {
            type: 'object', additionalProperties: true,
            properties: { id: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' }, start: { type: 'number' }, end: { type: 'number' }, track: { type: 'integer' } },
          },
        },
        dryRun: { type: 'boolean', description: 'op=write: validate and report without saving.' },
        maxChars: { type: 'integer', minimum: 8, maximum: 40, description: 'op=subtitles: characters per subtitle line (default 16).' },
      },
    },
    output: { schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof isProjectAgent !== 'function' || isProjectAgent(exec?.agent) !== true) {
        throw new Error('This tool is available only to a conversation bound to an OpenFilm project.');
      }
      const project = projectOf?.(exec.agent);
      if (!project?.path) throw new Error('This conversation is not bound to an OpenFilm project.');
      const op = typeof args?.op === 'string' ? args.op : 'read';

      if (op === 'read') {
        const storyboard = readStoryboard(project.path);
        if (!storyboard) return { text: '这个项目还没有分镜（.film/storyboard.json）。先写一份，再动时间轴。' };
        return { text: `${storyboardSummary(storyboard)}\n\n文件：.film/storyboard.json` };
      }

      if (op === 'write') {
        const input = args?.storyboard;
        if (!input || typeof input !== 'object') throw new Error('op=write 需要 storyboard。');
        const normalized = normalizeStoryboard(input);
        const { errors, warnings } = validateStoryboard(normalized);
        if (errors.length) throw new Error(`分镜不成立：\n· ${errors.join('\n· ')}`);
        if (args?.dryRun === true) {
          return { text: `试算（未保存）\n${storyboardSummary(normalized)}${warnings.length ? `\n\n提醒：\n· ${warnings.join('\n· ')}` : ''}` };
        }
        writeStoryboard(project.path, normalized);
        return { text: `已保存分镜：${storyboardSummary(normalized)}${warnings.length ? `\n\n提醒：\n· ${warnings.join('\n· ')}` : ''}` };
      }

      if (op === 'plan') {
        const storyboard = readStoryboard(project.path);
        if (!storyboard) throw new Error('还没有分镜。先 op=write 写一份。');
        const { operations, missing, conflicts } = planFromStoryboard(storyboard, args?.clips ?? []);
        const lines = [];
        if (operations.length) {
          lines.push(`时间轴操作（交给 openfilm_clip）：${operations.length} 步`);
          for (const operation of operations.slice(0, 60)) lines.push(`· ${JSON.stringify(operation)}`);
        } else lines.push('现有片段已经与分镜一致，没有要改的。');
        if (missing.length) {
          lines.push('', `还缺 ${missing.length} 个镜头，openfilm_clip 加不了片段：先在 Studio 里放上素材，或对已导入的片段补 clip id。`);
          for (const shot of missing.slice(0, 40)) lines.push(`· ${shot.id} ${shot.from}–${shot.to}s ${shot.kind}${shot.clip ? `（clip ${shot.clip} 不存在）` : ''}`);
        }
        if (conflicts.length) lines.push('', `冲突：\n· ${conflicts.join('\n· ')}`);
        return { text: lines.join('\n') };
      }

      if (op === 'from-script') {
        const file = typeof args?.transcriptPath === 'string' ? args.transcriptPath : '';
        if (!file) throw new Error('op=from-script 需要 transcriptPath（openfilm_transcribe 返回的路径）。');
        let record;
        try { record = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`读不到转写文件：${file}`); }
        const plan = planFromTranscript(record, { maxChars: args?.maxChars });
        if (plan.shots.length === 0) throw new Error('这份转写没有可用的句子（segments 为空或没有时间码）。');
        const storyboard = normalizeStoryboard(storyboardFromPlan(plan, {}));
        const { errors, warnings } = validateStoryboard(storyboard);
        if (errors.length) throw new Error(`按口播生成的分镜不成立：\n· ${errors.join('\n· ')}`);
        if (args?.dryRun === true) return { text: `试算（未保存）\n${storyboardSummary(storyboard)}` };
        writeStoryboard(project.path, storyboard);
        return {
          text: `已按口播生成分镜：${storyboardSummary(storyboard)}\n每镜一句、切在句尾；屏上字取了每镜第一句的前 40 字，按需要改。${warnings.length ? `\n\n提醒：\n· ${warnings.join('\n· ')}` : ''}`,
        };
      }

      // op === 'subtitles'
      const storyboard = readStoryboard(project.path);
      const transcriptPath = typeof args?.transcriptPath === 'string' ? args.transcriptPath : '';
      let sentences;
      if (transcriptPath) {
        let record;
        try { record = JSON.parse(readFileSync(transcriptPath, 'utf8')); } catch { throw new Error(`读不到转写文件：${transcriptPath}`); }
        sentences = sentencesFromSegments(record?.segments);
      } else if (storyboard) {
        // Without a transcript, the storyboard's captions are the subtitles: one cue
        // per shot, which is what a title-driven film has anyway.
        sentences = storyboard.shots.filter(shot => shot.caption).map(shot => ({ start: shot.from, end: shot.to, text: shot.caption }));
      } else {
        throw new Error('没有转写也没有分镜：先 openfilm_transcribe，或 op=write 写分镜。');
      }
      const cues = subtitlesFromScript(sentences, { maxChars: Number.isSafeInteger(args?.maxChars) ? args.maxChars : 16 });
      if (cues.length === 0) throw new Error('没有可用的字幕文本。');
      return { text: `字幕 ${cues.length} 条（SRT）：\n\n${toSrt(cues)}` };
    },
  };
}
