import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBrandLogo, brandLogoOps } from '../src/film/brand-logo-layer.mjs';
import { filmHtml, readFilmFile } from '../vendor/film-doc.mjs';

const src = `assets/brand/${'e'.repeat(64)}.png`;
const profile = { mode: 'snapshot', enabled: true, placement: 'top-left', logo: { path: src, width: 240, height: 120 } };
const doc = (w = 1080, h = 1920) => ({ stage: { w, h }, tracks: [
  { clips: [{ id: 'opening', src: 'pages/opening.html', at: 0.5, time: [0, 4] }] },
  { clips: [{ id: 'music', src: 'assets/music.mp3', time: [0, 12] }] },
] });

test('brand applies only as a small native still during the opening, preserving visual and audio tracks', () => {
  const original = doc();
  const [insert] = brandLogoOps(original, profile);
  assert.deepEqual(insert.track, { insert: 0 });
  assert.equal(insert.at, 0.68);
  assert.deepEqual(insert.clip.time, [0, 2.2]);
  assert.deepEqual(insert.clip.box, { x: 78, y: 78, w: 146, h: 73 });
  const withLogo = { ...original, tracks: [{ clips: [{ ...insert.clip, at: insert.at }] }, ...original.tracks] };
  const { doc: parsed, problems } = readFilmFile(filmHtml(withLogo));
  assert.deepEqual(problems, []);
  assert.equal(parsed.tracks[0].clips[0].src, src);
  assert.equal(parsed.tracks[1].clips[0].id, 'opening');
  assert.equal(parsed.tracks[2].clips[0].id, 'music');
  assert.deepEqual(brandLogoOps(parsed, profile), []);
});

test('position and replacement are precise native edits, with no changes to manual trim or scale', () => {
  const film = doc(1920, 1080);
  const logo = brandLogoOps(film, profile)[0].clip;
  film.tracks.unshift({ clips: [{ ...logo, at: 1, time: [0, 1], box: { ...logo.box, w: 100, h: 50, r: 1 } }] });
  const next = { ...profile, placement: 'bottom-right', logo: { ...profile.logo, path: src.replace('e'.repeat(64), 'a'.repeat(64)) } };
  const edits = brandLogoOps(film, next)[0].edits;
  assert.deepEqual(edits.map(edit => edit.prop), ['src', 'box']);
  assert.deepEqual(edits[1].value, { x: 1742, y: 952, w: 100, h: 50, r: 1 });
  assert.deepEqual(brandLogoOps(film, next, 'remove'), [{ op: 'remove', clip: logo.id }]);
  film.tracks[0].locked = true;
  assert.throws(() => brandLogoOps(film, next), { code: 'BRAND_LOGO_LOCKED' });
  film.tracks[0].locked = false;
  film.tracks[0].clips[0].src = 'assets/other.png';
  assert.throws(() => brandLogoOps(film, null, 'remove'), { code: 'BRAND_LOGO_CONFLICT' });
});

test('Studio edit requires a revision baseline, never retries after conflict, and does not extend an empty timeline', async () => {
  const writes = [];
  const adapter = { get: () => ({ doc: doc(), rev: 'base-revision' }), post: (...args) => { writes.push(args); throw new Error('timeline changed'); } };
  await assert.rejects(applyBrandLogo(adapter, 'project-id', profile), /timeline changed/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], '/api/projects/project-id/edit');
  assert.equal(writes[0][1].body.base, 'base-revision');
  await assert.rejects(applyBrandLogo({ ...adapter, get: () => ({ doc: doc() }) }, 'project-id', profile), { code: 'BRAND_LOGO_REVISION' });
  assert.equal(writes.length, 1);
  assert.throws(() => brandLogoOps({ ...doc(), tracks: [] }, profile), { code: 'BRAND_LOGO_NEEDS_PICTURE' });
});
