// From a spoken video to a cut: the timed script, the cut points, the subtitles.
//
// The first thing a person does with a talking-head video is not "arrange clips" —
// it is "listen to it and write down what was said, with times". `openfilm_transcribe`
// already produces those segments on this CPU. What was missing is the step that turns
// segments into something a timeline can use:
//
//   segments → sentences (with times) → shots (grouped on sentence ends) → subtitles
//
// All of it is pure and synchronous: the same input always gives the same cut, which
// is what makes a re-run reviewable instead of a new film each time.
import { MOTIONS } from './storyboard.mjs';

/** A sentence is a segment's text, split on its own punctuation, keeping the times. */
export function sentencesFromSegments(segments = []) {
  const kept = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    const start = Number(segment?.start);
    const end = Number(segment?.end);
    const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
    const parts = text.split(/(?<=[。！？!?；;])/u).map(part => part.trim()).filter(Boolean);
    if (parts.length <= 1) { kept.push({ start, end, text }); continue; }
    // Split the time in proportion to the characters: an approximation, but it keeps
    // every sentence inside its own segment and never crosses a real pause.
    const total = parts.reduce((sum, part) => sum + part.length, 0) || 1;
    let cursor = start;
    for (const part of parts) {
      const span = (end - start) * (part.length / total);
      kept.push({ start: cursor, end: cursor + span, text: part });
      cursor += span;
    }
  }
  return kept;
}

/**
 * Group sentences into shots.
 *
 * A shot ends on a sentence boundary, is at least `min` seconds, and stops before
 * `max`; a single sentence longer than `max` becomes its own shot (cutting inside a
 * sentence is worse than a long shot). `pad` trims a little off the tail so two
 * consecutive shots do not both hold the same half-second of room tone.
 */
export function shotsFromScript(sentences = [], { min = 2.5, max = 8, pad = 0.12 } = {}) {
  const shots = [];
  let current;
  const close = () => {
    if (!current) return;
    const to = Math.max(current.from + 0.1, current.to - pad);
    shots.push({
      id: `s${shots.length + 1}`,
      from: Math.round(current.from * 1000) / 1000,
      to: Math.round(to * 1000) / 1000,
      kind: 'talking-head',
      motion: MOTIONS.includes('none') ? 'none' : 'none',
      caption: current.text.slice(0, 40),
      lines: current.lines,
    });
    current = undefined;
  };
  for (const sentence of Array.isArray(sentences) ? sentences : []) {
    const start = Number(sentence?.start);
    const end = Number(sentence?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (!current) { current = { from: start, to: end, text: sentence.text ?? '', lines: 1 }; continue; }
    const span = end - current.from;
    if (span <= max) {
      current.to = end;
      current.text = `${current.text} ${sentence.text ?? ''}`.trim();
      current.lines += 1;
      if (end - current.from >= min) close();
      continue;
    }
    close();
    current = { from: start, to: end, text: sentence.text ?? '', lines: 1 };
    if (end - start >= min) close();
  }
  close();
  // A shot shorter than `min` at the end is folded into the previous one rather than
  // left as a flash frame.
  if (shots.length > 1) {
    const last = shots[shots.length - 1];
    if (last.to - last.from < min) {
      shots.pop();
      const previous = shots[shots.length - 1];
      previous.to = last.to;
      previous.caption = `${previous.caption} ${last.caption}`.trim().slice(0, 40);
      previous.lines += last.lines;
    }
  }
  return shots;
}

/** Subtitle cues: one per sentence, wrapped at `maxChars` per line (at most two lines). */
export function subtitlesFromScript(sentences = [], { maxChars = 16, maxLines = 2, min = 0.8 } = {}) {
  const cues = [];
  for (const sentence of Array.isArray(sentences) ? sentences : []) {
    const start = Number(sentence?.start);
    const end = Number(sentence?.end);
    const text = typeof sentence?.text === 'string' ? sentence.text.trim() : '';
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue;
    if (end - start < 0.2) continue;
    // One cue per sentence, at most `maxLines` rows of `maxChars`: a subtitle that
    // changes mid-sentence is harder to read than a two-line one.
    const rows = wrapCjk(text, maxChars);
    for (let index = 0; index < rows.length; index += maxLines) {
      cues.push({
        from: Math.round(start * 1000) / 1000,
        to: Math.round(Math.max(end, start + min) * 1000) / 1000,
        text: rows.slice(index, index + maxLines).join('\n'),
      });
    }
  }
  return cues;
}

/**
 * Break a CJK line into readable rows: at most `limit` characters, splitting on
 * punctuation first, then on a space, then anywhere. Latin text splits on words.
 */
export function wrapCjk(text, limit = 32) {
  const value = String(text ?? '').trim();
  if (!value) return [];
  if (value.length <= limit) return [value];
  const rows = [];
  let rest = value;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const breakAt = Math.max(
      window.lastIndexOf('，'), window.lastIndexOf('。'), window.lastIndexOf('、'),
      window.lastIndexOf(' '), window.lastIndexOf('；'), window.lastIndexOf('：'),
    );
    const cut = breakAt > limit * 0.4 ? breakAt + 1 : limit;
    rows.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) rows.push(rest);
  return rows;
}

/** SRT, the one subtitle format every player reads. */
export function toSrt(cues = []) {
  const stamp = seconds => {
    const total = Math.max(0, seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = Math.floor(total % 60);
    const millis = Math.round((total - Math.floor(total)) * 1000);
    const pad = (value, size) => String(value).padStart(size, '0');
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(millis, 3)}`;
  };
  return cues.map((cue, index) => `${index + 1}\n${stamp(cue.from)} --> ${stamp(cue.to)}\n${cue.text}\n`).join('\n');
}

/**
 * The whole plan for a transcript: sentences, shots, subtitles.
 *
 * @param {{segments?: Array<{start: number, end: number, text: string}>}} record - a transcript record
 */
export function planFromTranscript(record, options = {}) {
  const sentences = sentencesFromSegments(record?.segments);
  const duration = sentences.length ? Math.round(sentences[sentences.length - 1].end * 1000) / 1000 : 0;
  const shots = shotsFromScript(sentences, options);
  const subtitles = subtitlesFromScript(sentences, options);
  return { duration, sentences, shots, subtitles };
}

/** A storyboard whose shots are the transcript's sentences, ready to be edited. */
export function storyboardFromPlan(plan, { title = '', brief = '', style = '' } = {}) {
  return {
    version: 1,
    ...(title ? { title } : {}),
    ...(brief ? { brief } : {}),
    ...(style ? { style } : {}),
    duration: plan.duration,
    shots: plan.shots.map(shot => ({
      id: shot.id,
      from: shot.from,
      to: shot.to,
      kind: shot.kind,
      motion: shot.motion,
      ...(shot.caption ? { caption: shot.caption } : {}),
    })),
  };
}
