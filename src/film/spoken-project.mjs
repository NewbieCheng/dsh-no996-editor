import { readFileSync } from 'node:fs';
import { shotWall } from '../../vendor/templates/_kit/render.mjs';
import { renderSpokenVibeScene } from '../../vendor/templates/_kit/vibe/editable-page.mjs';
import { addMeasuredAccents } from './spoken-blueprint.mjs';

const motionUrl = new URL('../../vendor/templates/_kit/motion/motion.js', import.meta.url);

/** Pure project contents (apart from reading the bundled runtime). Only accepts a
 * blueprint produced by buildSpokenBlueprint, never model-supplied file paths. */
export function spokenProjectFiles(blueprint, { title = 'Vibe · 口播草稿', bgm = null } = {}) {
  if (bgm && (blueprint.music !== bgm.mode || blueprint.music === 'none')) throw new Error('BGM mode does not match the spoken blueprint');
  blueprint = addMeasuredAccents(blueprint, bgm?.analysis);
  const size = blueprint.ratio === '16:9' ? [1920, 1080] : [1080, 1920];
  const paths = new Map([['assets/motion.js', readFileSync(motionUrl, 'utf8')]]);
  const audioTracks = [];
  if (bgm) {
    const duration = Math.min(blueprint.durationMs, Math.floor(bgm.analysis.durationSec * 1000)) / 1000;
    paths.set(bgm.path, bgm.bytes);
    paths.set('.film/rhythm.json', `${JSON.stringify({ version: 1, source: bgm.path, sha256: bgm.sha256, analysis: bgm.analysis }, null, 2)}\n`);
    audioTracks.push({ id: 'bgm', title: '背景音乐', clips: [{ src: bgm.path, at: 0, duration, volume: bgm.volume }] });
  }
  const wall = blueprint.scenes.map((scene, index) => {
    const id = `spoken-${index + 1}`;
    // Keep the picture present across pauses without changing speech cue times.
    const start = index === 0 ? 0 : scene.fromMs;
    const end = blueprint.scenes[index + 1]?.fromMs ?? blueprint.durationMs;
    const cues = blueprint.subtitles.filter(cue => cue.sceneId === id);
    const accent = blueprint.accents?.find(candidate => candidate.sceneId === id)?.atMs;
    paths.set(`pages/${id}.html`, renderSpokenVibeScene(scene, size, cues, accent, start, end));
    return { id, title: scene.headline, start: start / 1000, duration: (end - start) / 1000 };
  });
  paths.set('film.html', shotWall({ title, size, shots: wall, audioTracks, sectionTitle: '口播分镜' }));
  // Design prompts are saved as data for follow-up editing, never embedded as code
  // or used as runtime instructions. They do not become visible captions.
  paths.set('.film/spoken-blueprint.json', `${JSON.stringify(blueprint, null, 2)}\n`);
  return paths;
}
