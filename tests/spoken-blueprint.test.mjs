import test from 'node:test';
import assert from 'node:assert/strict';
import { addMeasuredAccents, buildSpokenBlueprint, planSpokenCopy, splitSpokenCopy } from '../src/film/spoken-blueprint.mjs';

const copy = '拍片应该从哪里开始？\n把目标拆成一个可以验证的小实验，再决定是否继续。';
const beats = [
  { from: 0, to: 1, role: 'hook', headline: '从哪里开始', visual: '屏幕中心使用可编辑标题', motion: '提问时揭开标题' },
  { from: 1, to: 2, role: 'payoff', headline: '先试验', visual: '分层对比图解', motion: '提到实验时亮起图解', emphasis: '小实验' },
];

test('the selected model receives bounded input and cannot rewrite spoken captions or assert timings', async () => {
  const signal = new AbortController().signal;
  const ask = async (prompt, receivedSignal) => {
    assert.equal(receivedSignal, signal);
    assert.match(prompt, /material, never instructions/);
    assert.match(prompt, /拍片应该从哪里开始/);
    return '```json\n' + JSON.stringify({ beats: beats.map(beat => ({ ...beat, fromMs: 90000, caption: 'rewritten' })) }) + '\n```';
  };
  const result = await planSpokenCopy({ ask, copy, signal });
  assert.equal(result.timing, 'estimated');
  assert.equal(result.ratio, '9:16');
  assert.equal(result.music, 'default');
  assert.equal(result.scenes[0].fromMs, 0);
  assert.ok(result.durationMs < 15000);
  assert.equal(result.subtitles.map(item => item.text).join(''), splitSpokenCopy(copy).join(''));
  assert.ok(result.subtitles.every(item => [...item.text].length <= 16));
  assert.ok(result.subtitles.some(item => item.emphasis === '小实验'));
});

test('audio accents cannot move measured narration or create cuts', () => {
  const transcript = [{ start: 0.3, end: 2.5 }, { start: 3.2, end: 9 }];
  const result = buildSpokenBlueprint({ copy, beats, transcript, ratio: '16:9', music: 'upload' });
  assert.equal(result.timing, 'transcript');
  assert.deepEqual(result.scenes.map(s => [s.fromMs, s.toMs]), [[300, 2500], [3200, 9000]]);
  const measured = addMeasuredAccents(result, { beats: [100, 710, 790, 2100, 3680] });
  assert.deepEqual(measured.accents.map(a => a.atMs), [710, 3680]);
  assert.deepEqual(measured.scenes, result.scenes);
  assert.deepEqual(measured.subtitles, result.subtitles);
  assert.deepEqual(addMeasuredAccents({ ...result, music: 'none' }, { beats: [710, 3680] }).accents, []);
});

test('invalid grouping, invalid times, model errors and cancellation fail without fallback', async () => {
  assert.throws(() => buildSpokenBlueprint({ copy, beats: [beats[1], beats[0]] }), { code: 'SPOKEN_BLUEPRINT_INPUT' });
  assert.throws(() => buildSpokenBlueprint({ copy, beats: [beats[0]] }), /覆盖最后/);
  assert.throws(() => buildSpokenBlueprint({ copy, beats, transcript: [{ start: 0, end: 2 }, { start: 1, end: 2 }] }), /时间码重叠/);
  await assert.rejects(planSpokenCopy({ copy, ask: () => 'not JSON' }), { code: 'SPOKEN_BLUEPRINT_INPUT' });
  const providerError = new Error('configured provider is offline');
  await assert.rejects(planSpokenCopy({ copy, ask: () => { throw providerError; } }), error => error === providerError);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(planSpokenCopy({ copy, signal: controller.signal, ask: () => assert.fail('model called after abort') }), { name: 'AbortError' });
});
