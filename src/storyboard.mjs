// The storyboard: the contract between "what the person asked for" and "what the
// timeline does".
//
// Why a file instead of prose: an agent that plans in its own head re-plans on every
// turn, and every re-plan is a different film. A storyboard on disk is reviewable
// before anything is cut, it survives a restart, and the timing edits can be derived
// from it instead of guessed. `.film/storyboard.json` sits beside the film, so it is
// the project's own record, not the panel's.
//
// The schema is deliberately small: shots, seconds, a source, a motion name, a
// caption. Anything a person would want to review is here; anything the timeline can
// compute (frames, easing) is not.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STORYBOARD_FILE = join('.film', 'storyboard.json');
export const VERSION = 1;

/** The motion vocabulary the film runtime understands (see docs/MOTION.md). */
export const MOTIONS = [
  'none', 'fade', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down',
  'zoom-in', 'zoom-out', 'slide-up', 'slide-down', 'reveal-left', 'reveal-right', 'parallax',
];

export const KINDS = ['talking-head', 'broll', 'title', 'cutaway', 'screen', 'end-card'];

const round = value => Math.round(value * 1000) / 1000;

/**
 * Check a storyboard without changing it.
 *
 * Errors are what make it unusable (a shot that starts after it ends, overlapping
 * shots, an unknown kind); warnings are what a person may still accept (a shot over
 * 12 s, a caption that will wrap). The caller decides what to refuse.
 *
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateStoryboard(input) {
  const errors = [];
  const warnings = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['storyboard 必须是一个对象'], warnings };
  if (input.version !== undefined && input.version !== VERSION) errors.push(`version 必须是 ${VERSION}`);
  if (typeof input.title === 'string' && input.title.length > 120) errors.push('title 超过 120 字');
  const shots = Array.isArray(input.shots) ? input.shots : null;
  if (!shots) return { errors: [...errors, 'shots 必须是数组'], warnings };
  if (shots.length === 0) errors.push('至少要有 1 个镜头');
  if (shots.length > 200) errors.push('镜头超过 200 个，先拆成两支片');
  let previousTo = 0;
  const seen = new Set();
  for (const [index, shot] of shots.entries()) {
    const at = `第 ${index + 1} 镜`;
    if (!shot || typeof shot !== 'object') { errors.push(`${at} 不是一个对象`); continue; }
    if (typeof shot.id !== 'string' || !shot.id.trim()) errors.push(`${at} 缺少 id`);
    else if (seen.has(shot.id)) errors.push(`${at} 的 id "${shot.id}" 重复`);
    else seen.add(shot.id);
    const from = Number(shot.from);
    const to = Number(shot.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) { errors.push(`${at} 的 from/to 必须是秒数`); continue; }
    if (from < 0) errors.push(`${at} 的 from 不能是负数`);
    if (to <= from) errors.push(`${at} 的 to 必须大于 from`);
    if (from < previousTo - 0.001) errors.push(`${at} 与前一个镜头重叠（${round(from)} < ${round(previousTo)}）`);
    previousTo = Math.max(previousTo, to);
    if (to - from > 12) warnings.push(`${at} 长 ${round(to - from)} 秒，超过 12 秒的镜头通常该拆`);
    if (shot.kind !== undefined && !KINDS.includes(shot.kind)) errors.push(`${at} 的 kind 必须是 ${KINDS.join('/')}`);
    if (shot.motion !== undefined && !MOTIONS.includes(shot.motion)) errors.push(`${at} 的 motion "${shot.motion}" 不在动作词汇表里`);
    if (shot.caption !== undefined && typeof shot.caption !== 'string') errors.push(`${at} 的 caption 必须是字符串`);
    if (typeof shot.caption === 'string' && shot.caption.length > 40) warnings.push(`${at} 的屏上字超过 40 字，会折行`);
    if (typeof shot.source === 'string' && shot.source && /^[A-Za-z]:[\\/]/.test(shot.source)) {
      warnings.push(`${at} 的 source 是绝对路径；项目外的素材先 openfilm_assets 导入再引用`);
    }
  }
  if (input.duration !== undefined) {
    const duration = Number(input.duration);
    if (!Number.isFinite(duration) || duration <= 0) errors.push('duration 必须是正数');
    else if (previousTo > duration + 0.001) warnings.push(`镜头结束于 ${round(previousTo)} 秒，超过 duration ${round(duration)} 秒`);
  }
  return { errors, warnings };
}

/** Fill in defaults and round the numbers, so two writers produce the same file. */
export function normalizeStoryboard(input) {
  const shots = (Array.isArray(input?.shots) ? input.shots : []).map((shot, index) => ({
    id: typeof shot?.id === 'string' && shot.id.trim() ? shot.id.trim() : `s${index + 1}`,
    from: round(Number(shot?.from) || 0),
    to: round(Number(shot?.to) || 0),
    ...(typeof shot?.clip === 'string' && shot.clip ? { clip: shot.clip } : {}),
    ...(typeof shot?.source === 'string' && shot.source ? { source: shot.source } : {}),
    ...(Number.isFinite(Number(shot?.in)) ? { in: round(Number(shot.in)) } : {}),
    ...(Number.isFinite(Number(shot?.out)) ? { out: round(Number(shot.out)) } : {}),
    kind: KINDS.includes(shot?.kind) ? shot.kind : 'broll',
    motion: MOTIONS.includes(shot?.motion) ? shot.motion : 'none',
    ...(typeof shot?.caption === 'string' && shot.caption.trim() ? { caption: shot.caption.trim() } : {}),
    ...(typeof shot?.transition === 'string' && shot.transition ? { transition: shot.transition } : {}),
    ...(typeof shot?.notes === 'string' && shot.notes ? { notes: shot.notes.slice(0, 200) } : {}),
  }));
  return {
    version: VERSION,
    ...(typeof input?.title === 'string' && input.title.trim() ? { title: input.title.trim().slice(0, 120) } : {}),
    ...(typeof input?.brief === 'string' && input.brief.trim() ? { brief: input.brief.trim().slice(0, 400) } : {}),
    ...(typeof input?.style === 'string' && input.style.trim() ? { style: input.style.trim().slice(0, 60) } : {}),
    duration: round(Number(input?.duration) || (shots.length ? shots[shots.length - 1].to : 0)),
    shots,
  };
}

/** A few lines a person can read without opening the JSON. */
export function storyboardSummary(storyboard) {
  const shots = Array.isArray(storyboard?.shots) ? storyboard.shots : [];
  const lines = [`${shots.length} 个镜头，共 ${round(storyboard?.duration ?? 0)} 秒${storyboard?.style ? `，风格 ${storyboard.style}` : ''}`];
  for (const shot of shots.slice(0, 40)) {
    const caption = shot.caption ? `「${shot.caption}」` : '';
    lines.push(`· ${shot.id} ${round(shot.from)}–${round(shot.to)}s ${shot.kind} ${shot.motion}${caption}`);
  }
  if (shots.length > 40) lines.push(`· …还有 ${shots.length - 40} 个`);
  return lines.join('\n');
}

/**
 * The timeline operations a storyboard implies for clips that already exist.
 *
 * `openfilm_clip` can move, trim and split; it cannot add. So a shot whose `clip`
 * names an existing clip becomes a trim + move, and a shot with no clip is reported
 * as "add this one" instead of being silently skipped.
 *
 * @param {object} storyboard - normalized
 * @param {Array<{id: string, from?: number, to?: number, start?: number, end?: number, track?: number}>} clips
 */
export function planFromStoryboard(storyboard, clips = []) {
  const known = new Map((Array.isArray(clips) ? clips : []).filter(clip => typeof clip?.id === 'string').map(clip => [clip.id, clip]));
  const operations = [];
  const missing = [];
  const conflicts = [];
  for (const shot of storyboard?.shots ?? []) {
    if (!shot.clip) { missing.push({ id: shot.id, from: shot.from, to: shot.to, kind: shot.kind }); continue; }
    const clip = known.get(shot.clip);
    if (!clip) { missing.push({ id: shot.id, clip: shot.clip, from: shot.from, to: shot.to, kind: shot.kind }); continue; }
    // A trim changes the source range; a move changes where it sits on the film.
    const sourceStart = Number.isFinite(shot.in) ? shot.in : undefined;
    const sourceEnd = Number.isFinite(shot.out) ? shot.out : undefined;
    if (sourceStart !== undefined && sourceEnd !== undefined && sourceEnd > sourceStart) {
      operations.push({ op: 'trim', clip: shot.clip, start: round(sourceStart), end: round(sourceEnd) });
    } else if (Number.isFinite(shot.to) && Number.isFinite(shot.from) && clip.from !== undefined && clip.to !== undefined) {
      // No explicit source range: keep the shot's length by trimming the source the
      // same amount the storyboard changed.
      const current = Number(clip.to) - Number(clip.from);
      const wanted = shot.to - shot.from;
      if (Math.abs(current - wanted) > 0.05 && Number.isFinite(clip.start)) {
        operations.push({ op: 'trim', clip: shot.clip, start: round(Number(clip.start)), end: round(Number(clip.start) + wanted) });
      }
    }
    operations.push({ op: 'move', clip: shot.clip, at: round(shot.from), ...(Number.isInteger(clip.track) ? {} : {}) });
    if (shot.to > (storyboard.duration ?? Infinity) + 0.001) conflicts.push(`${shot.id} 结束于 ${round(shot.to)}s，超出总时长`);
  }
  return { operations, missing, conflicts };
}

/** Read the project's storyboard, or undefined when it has none. */
export function readStoryboard(projectPath, fs = { readFileSync, existsSync }) {
  const file = join(projectPath, STORYBOARD_FILE);
  try {
    if (!fs.existsSync(file)) return undefined;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || !Array.isArray(value.shots)) return undefined;
    return value;
  } catch { return undefined; }
}

/** Write it atomically enough for a project file: temp, then rename. */
export function writeStoryboard(projectPath, storyboard, fs = { writeFileSync, mkdirSync, renameSync }) {
  const file = join(projectPath, STORYBOARD_FILE);
  fs.mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(storyboard, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return file;
}
