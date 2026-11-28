import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFilmFile } from 'openfilm/film-doc';
import { inspectPageEditableLayers } from '../src/film/editable-check.mjs';
import { buildSpokenBlueprint, addMeasuredAccents } from '../src/film/spoken-blueprint.mjs';
import { spokenProjectFiles } from '../src/film/spoken-project.mjs';

const draft = ratio => addMeasuredAccents(buildSpokenBlueprint({
  ratio, copy: '开场第一句。下一句有<图解>。', transcript: [{ start: 0.3, end: 2 }, { start: 2.5, end: 5 }],
  beats: [
    { from: 0, to: 1, role: 'hook', headline: '<标题>', visual: '不显示的场景提示', motion: '保持对比' },
    { from: 1, to: 2, role: 'payoff', headline: '展开图解', visual: '不显示的图解提示', motion: '排列', emphasis: '<图解>' },
  ],
}), { beats: [750, 2960] });

for (const [ratio, size] of [['9:16', [1080, 1920]], ['16:9', [1920, 1080]]]) {
  test(`spoken project ${ratio} saves a playable film with independent editable cues`, t => {
    const root = mkdtempSync(join(tmpdir(), 'no996-spoken-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const blueprint = draft(ratio);
    const bgm = { mode: 'default', path: 'assets/audio/bgm/music.mp3', bytes: Buffer.from([1, 2]), sha256: 'fixture', volume: 0.16,
      analysis: { durationSec: 12, beats: [750, 2960] } };
    for (const [relative, body] of spokenProjectFiles(blueprint, { bgm })) {
      const file = join(root, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body, { flag: 'wx' });
    }
    const film = readFilmFile(readFileSync(join(root, 'film.html'), 'utf8'));
    assert.deepEqual(film.problems, []);
    assert.deepEqual([film.doc.stage.w, film.doc.stage.h], size);
    assert.deepEqual(film.doc.tracks[0].clips.map(c => [c.at, c.src]), [[0, 'pages/spoken-1.html'], [2.5, 'pages/spoken-2.html']]);
    const first = readFileSync(join(root, film.doc.tracks[0].clips[0].src), 'utf8');
    const second = readFileSync(join(root, film.doc.tracks[0].clips[1].src), 'utf8');
    assert.match(first, /data-from="300" data-to="2000"/);
    assert.match(second, /data-from="0" data-to="2500"/);
    assert.match(first, /const accent = 0\.75/);
    assert.match(second, /<strong>&lt;图解&gt;<\/strong>/);
    assert.match(first, /&lt;标题&gt;/);
    assert.doesNotMatch(first, /不显示的场景提示|<标题>/);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.film/spoken-blueprint.json'))), blueprint);
    const editable = inspectPageEditableLayers(second);
    assert.equal(editable.canvasCount, 0);
    assert.deepEqual(editable.duplicateElementIds, []);
    assert.ok(editable.elements.some(item => item.elementId === 'vibe-caption-2'));
  });
}
