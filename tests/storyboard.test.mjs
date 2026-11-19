// The storyboard and the script→cut pipeline: what the director tool promises.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  GROWTH_TYPES, MOTIONS, normalizeStoryboard, planFromStoryboard, readStoryboard, storyboardSummary, validateStoryboard, writeStoryboard,
} from '../src/film/storyboard.mjs';
import {
  planFromTranscript, sentencesFromSegments, shotsFromScript, storyboardFromPlan, subtitlesFromScript, toSrt, wrapCjk,
} from '../src/film/script-plan.mjs';
import { createStoryboardTool } from '../src/tools/storyboard-tool.mjs';
import { catalogText, searchTemplates, scoreTemplate, templateCatalog } from '../src/film/template-catalog.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'no996-storyboard-'));

const shot = (id, from, to, extra = {}) => ({ id, from, to, ...extra });

test('a storyboard is refused when its shots overlap or run backwards', () => {
  const overlap = validateStoryboard({ shots: [shot('s1', 0, 3), shot('s2', 2, 5)] });
  assert.ok(overlap.errors.some(error => error.includes('重叠')));
  const backwards = validateStoryboard({ shots: [shot('s1', 4, 2)] });
  assert.ok(backwards.errors.some(error => error.includes('to 必须大于 from')));
  const duplicate = validateStoryboard({ shots: [shot('s1', 0, 2), shot('s1', 2, 4)] });
  assert.ok(duplicate.errors.some(error => error.includes('重复')));
  const unknownMotion = validateStoryboard({ shots: [shot('s1', 0, 2, { motion: 'spin-360' })] });
  assert.ok(unknownMotion.errors.some(error => error.includes('动作词汇表')));
});

test('a long shot and a long caption are warnings, not refusals', () => {
  const { errors, warnings } = validateStoryboard({ shots: [shot('s1', 0, 20, { caption: '一'.repeat(60) })] });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some(warning => warning.includes('12 秒')));
  assert.ok(warnings.some(warning => warning.includes('屏上字')));
});

test('normalising fills the defaults the timeline needs', () => {
  const storyboard = normalizeStoryboard({ shots: [{ from: 0, to: 2.3456 }] });
  assert.equal(storyboard.version, 1);
  assert.equal(storyboard.shots[0].id, 's1');
  assert.equal(storyboard.shots[0].kind, 'broll');
  assert.equal(storyboard.shots[0].motion, 'none');
  assert.equal(storyboard.shots[0].to, 2.346);
  assert.equal(storyboard.duration, 2.346);
});

test('the storyboard round-trips through the project folder', () => {
  const root = scratch();
  const storyboard = normalizeStoryboard({ title: 'demo', shots: [shot('s1', 0, 3), shot('s2', 3, 6)] });
  writeStoryboard(root, storyboard);
  const back = readStoryboard(root);
  assert.equal(back.title, 'demo');
  assert.equal(back.shots.length, 2);
  assert.ok(readFileSync(join(root, '.film', 'storyboard.json'), 'utf8').includes('"s2"'));
  assert.equal(readStoryboard(join(root, 'nope')), undefined);
});

test('the summary is readable and bounded', () => {
  const storyboard = normalizeStoryboard({ shots: Array.from({ length: 45 }, (_, index) => shot(`s${index + 1}`, index, index + 1)) });
  const summary = storyboardSummary(storyboard);
  assert.ok(summary.startsWith('45 个镜头'));
  assert.ok(summary.includes('还有 5 个'));
});

test('plan turns shots into clip operations and names the ones that still need a clip', () => {
  const storyboard = normalizeStoryboard({
    shots: [
      shot('s1', 0, 3, { clip: 'clip-a', in: 1, out: 4 }),
      shot('s2', 3, 6, { clip: 'clip-b' }),
      shot('s3', 6, 9, { clip: 'clip-missing' }),
    ],
  });
  const { operations, missing } = planFromStoryboard(storyboard, [
    { id: 'clip-a', from: 0, to: 2, start: 0, end: 2 },
    { id: 'clip-b', from: 2, to: 4, start: 10, end: 12 },
  ]);
  assert.deepEqual(operations.find(operation => operation.clip === 'clip-a' && operation.op === 'trim'), { op: 'trim', clip: 'clip-a', start: 1, end: 4 });
  assert.ok(operations.some(operation => operation.op === 'move' && operation.clip === 'clip-b' && operation.at === 3));
  assert.ok(operations.some(operation => operation.op === 'trim' && operation.clip === 'clip-b' && operation.end === 13), 'clip-b is retimed to three seconds');
  assert.deepEqual(missing.map(entry => entry.id), ['s3']);
});

test('sentences keep their times and never cross a segment', () => {
  const sentences = sentencesFromSegments([
    { start: 0, end: 4, text: '第一句。第二句！' },
    { start: 4, end: 6, text: '第三句' },
  ]);
  assert.equal(sentences.length, 3);
  assert.equal(sentences[0].start, 0);
  assert.ok(sentences[1].end <= 4.0001);
  assert.equal(sentences[2].text, '第三句');
  assert.ok(sentences[1].start >= sentences[0].end - 0.0001);
});

test('shots end on sentence boundaries and stay inside the duration', () => {
  const sentences = [
    { start: 0, end: 1.2, text: '一' },
    { start: 1.2, end: 2.6, text: '二' },
    { start: 2.6, end: 4.0, text: '三' },
    { start: 4.0, end: 12.0, text: '四' },
  ];
  const shots = shotsFromScript(sentences, { min: 2, max: 6 });
  assert.ok(shots.length >= 2);
  for (const shot of shots) {
    assert.ok(shot.to > shot.from);
    assert.ok(sentences.some(sentence => Math.abs(sentence.end - shot.to) < 0.2 || Math.abs(sentence.end - 0.12 - shot.to) < 0.2), 'the cut sits on a sentence end');
  }
  assert.equal(shots[shots.length - 1].to <= 12.0001, true);
});

test('a transcript becomes a storyboard with one shot per group of sentences', () => {
  const plan = planFromTranscript({ segments: [{ start: 0, end: 3, text: '大家好。今天讲三件事。' }, { start: 3, end: 8, text: '第一件事。' }] });
  assert.ok(plan.sentences.length === 3);
  const storyboard = normalizeStoryboard(storyboardFromPlan(plan));
  assert.deepEqual(validateStoryboard(storyboard).errors, []);
  assert.equal(storyboard.duration, 8);
  assert.ok(storyboard.shots.length >= 2);
});

test('subtitles wrap without breaking a sentence and produce valid SRT', () => {
  const cues = subtitlesFromScript([{ start: 1, end: 3.5, text: '这是一句会被折行的字幕文本，用来检查折行是否按字宽断开' }], { maxChars: 10 });
  assert.ok(cues.length >= 2, `${cues.length} cues`);
  for (const cue of cues) for (const line of cue.text.split('\n')) assert.ok(line.length <= 10);
  const srt = toSrt([{ from: 1.5, to: 3.25, text: '第一行' }]);
  assert.equal(srt, '1\n00:00:01,500 --> 00:00:03,250\n第一行\n');
  assert.deepEqual(wrapCjk('短', 10), ['短']);
});

test('the tool writes, reads and plans through a project folder', async () => {
  const root = scratch();
  mkdirSync(join(root, '.film'), { recursive: true });
  const tool = createStoryboardTool({
    isProjectAgent: agent => agent?.id === 'agent',
    projectOf: () => ({ projectId: 'proj123456', path: root }),
  });
  const exec = { agent: { id: 'agent' } };
  const written = await tool.execute({
    op: 'write',
    storyboard: { title: 'demo', shots: [shot('s1', 0, 3), shot('s2', 3, 6, { caption: '第二镜' })] },
  }, exec);
  assert.match(written.text, /已保存分镜/);
  const read = await tool.execute({ op: 'read' }, exec);
  assert.match(read.text, /2 个镜头/);
  const planned = await tool.execute({ op: 'plan', clips: [{ id: 'x', from: 0, to: 3 }] }, exec);
  assert.match(planned.text, /还缺 2 个镜头/);
  await assert.rejects(tool.execute({ op: 'write', storyboard: { shots: [shot('s1', 5, 1)] } }, exec), /分镜不成立/);
  await assert.rejects(tool.execute({ op: 'read' }, { agent: { id: 'other' } }), /OpenFilm project/);
});

test('from-script builds the storyboard from a transcript file', async () => {
  const root = scratch();
  const transcript = join(root, 'transcript.json');
  writeFileSync(transcript, JSON.stringify({ segments: [{ start: 0, end: 2.5, text: '第一句。' }, { start: 2.5, end: 6, text: '第二句。' }] }), 'utf8');
  const tool = createStoryboardTool({ isProjectAgent: agent => agent?.id === 'agent', projectOf: () => ({ projectId: 'proj123456', path: root }) });
  const result = await tool.execute({ op: 'from-script', transcriptPath: transcript }, { agent: { id: 'agent' } });
  assert.match(result.text, /已按口播生成分镜/);
  const storyboard = readStoryboard(root);
  assert.ok(storyboard.shots.length >= 1);
  assert.equal(storyboard.duration, 6);
  const subtitles = await tool.execute({ op: 'subtitles', transcriptPath: transcript }, { agent: { id: 'agent' } });
  assert.match(subtitles.text, /--> /);
});

test('the template catalog is searchable and carries the per-template prompt', async () => {
  const root = scratch();
  mkdirSync(join(root, 'sketchnote'), { recursive: true });
  writeFileSync(join(root, 'sketchnote', 'manifest.json'), JSON.stringify({ id: 'sketchnote', title: '手绘笔记', description: '纸笔手绘风格', mode: 'film', entry: 'film.html' }));
  writeFileSync(join(root, 'sketchnote', 'prompt.md'), '# 手绘笔记\n\n保留纸张质感。\n');
  const catalog = await templateCatalog(root);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].prompt.includes('纸张质感'), true);
  assert.equal(scoreTemplate(catalog[0], '手绘') > 0, true);
  assert.equal(scoreTemplate(catalog[0], '赛博朋克'), 0);
  assert.deepEqual(searchTemplates(catalog, '手绘').map(item => item.id), ['sketchnote']);
  assert.match(catalogText(catalog), /sketchnote/);
  assert.deepEqual(await templateCatalog(join(root, 'nope')), []);
});

test('the motion vocabulary and growth fields enforce core motion rules', () => {
  assert.ok(MOTIONS.includes('push-in'));
  assert.ok(MOTIONS.includes('portal-zoom'));
  assert.ok(MOTIONS.includes('morph-expand'));
  assert.ok(GROWTH_TYPES.includes('line-grow'));
  assert.equal(new Set(MOTIONS).size, MOTIONS.length);
  const rich = normalizeStoryboard({
    shots: [shot('s1', 0, 4, {
      motion: 'portal-zoom',
      growth: 'morph-expand',
      camera: '全景建立→1.2s推镜特写',
      trigger: '光标点击胶囊触发弹出',
      explain: '天平失衡后反转',
      carryFrom: 'orb',
      sfx: 'hit@0.5s',
    })],
  });
  assert.equal(rich.shots[0].growth, 'morph-expand');
  assert.equal(rich.shots[0].camera, '全景建立→1.2s推镜特写');
  assert.equal(rich.shots[0].trigger, '光标点击胶囊触发弹出');

  const pptWarnings = validateStoryboard({
    shots: [
      shot('s1', 0, 2, { transition: 'wipe-band' }),
      shot('s2', 2, 4, { transition: 'wipe-band' }),
      shot('s3', 4, 6, { transition: 'wipe-band' }),
      shot('s4', 6, 8, { transition: 'wipe-band' }),
    ],
  }).warnings;
  assert.ok(pptWarnings.some(w => w.includes('PPT')));
  assert.ok(pptWarnings.some(w => w.includes('growth')));
  assert.ok(pptWarnings.some(w => w.includes('camera')));
});
