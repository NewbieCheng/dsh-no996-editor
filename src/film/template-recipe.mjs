import { createHash } from 'node:crypto';
import { isAbsolute, posix } from 'node:path';
import { clipSpan, kindOf } from '../../vendor/film-doc.mjs';
import { escapeHtml, page, shotWall } from '../../packages/no996-scene-kit/src/index.mjs';
import { sanitizeRecipeCss, sanitizeRecipeScene, validateRecipeScene } from './recipe-html.mjs';
import { brandForScene, isBrandPresentationClip } from './project-brand.mjs';

export const RECIPE_FILE = 'recipe.json';
export const RECIPE_VERSION = 1;
export const RECIPE_ASSET_BYTES = Symbol('recipeAssetBytes');
const ID = /^[a-z][a-z0-9-]{2,63}$/;
const EXT = new Set(['png', 'jpg', 'webp', 'gif', 'mp3', 'wav', 'flac', 'ogg']);
const bad = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const localPath = value => typeof value === 'string' && value.length < 300 && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && !value.includes('\\') && !value.includes('\0') && !value.split('/').includes('..');

export function normalizeRecipe(input) {
  if (!input || input.version !== RECIPE_VERSION || !ID.test(input.id) || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 80 ||
    typeof input.description !== 'string' || input.description.length > 400 || !Array.isArray(input.scenes) || !input.scenes.length || input.scenes.length > 32 ||
    !Number.isInteger(input.canvas?.w) || !Number.isInteger(input.canvas?.h) || input.canvas.w < 16 || input.canvas.h < 16 || input.canvas.w > 8192 || input.canvas.h > 8192 ||
    !['9:16', '16:9', '1:1'].includes(input.canvas.ratio) || !Array.isArray(input.assets) || input.assets.length > 128 ||
    (input.canvas.ratio === '9:16' && input.canvas.h <= input.canvas.w) || (input.canvas.ratio === '16:9' && input.canvas.w <= input.canvas.h) ||
    (input.canvas.ratio === '1:1' && input.canvas.w !== input.canvas.h)) throw bad('RECIPE_INPUT');
  const seen = new Set();
  const scenes = input.scenes.map((scene, index) => {
    if (!scene || !ID.test(scene.id) || seen.has(scene.id) || typeof scene.title !== 'string' || scene.title.length > 80 ||
      !Number.isFinite(scene.duration) || scene.duration < 0.3 || scene.duration > 600 || typeof scene.html !== 'string') throw bad('RECIPE_INPUT');
    seen.add(scene.id);
    const checked = validateRecipeScene(scene);
    return { id: scene.id, title: scene.title, duration: Math.round(scene.duration * 1000) / 1000,
      html: checked.html, labels: { ...scene.labels }, assets: { ...scene.assets } };
  });
  const assets = input.assets.map(asset => {
    const ext = asset?.path?.split('.').pop()?.toLowerCase();
    if (!asset || !localPath(asset.path) || !asset.path.startsWith('assets/') || !EXT.has(ext) || !/^[a-f0-9]{64}$/.test(asset.sha256) || asset.bytes < 1 || asset.bytes > 32 * 1024 * 1024 ||
      (asset.kind === 'image' && !['png', 'jpg', 'webp', 'gif'].includes(ext)) || (asset.kind === 'audio' && !['mp3', 'wav', 'flac', 'ogg'].includes(ext))) throw bad('RECIPE_INPUT');
    return { path: asset.path, sha256: asset.sha256, bytes: asset.bytes, kind: asset.kind };
  });
  if (new Set(assets.map(asset => asset.path)).size !== assets.length) throw bad('RECIPE_INPUT');
  const paths = new Set(assets.map(asset => asset.path));
  for (const scene of scenes) for (const path of Object.values(scene.assets)) if (!paths.has(path)) throw bad('RECIPE_INPUT');
  const output = { version: RECIPE_VERSION, id: input.id, title: input.title.trim(), description: input.description.trim(), canvas: { ...input.canvas }, scenes, assets };
  if (input.bgm) {
    const b = input.bgm;
    if (!paths.has(b.path) || !Number.isFinite(b.volume) || b.volume < 0 || b.volume > 1 || !Number.isFinite(b.duration) || b.duration <= 0 || b.duration > 86400 || !Array.isArray(b.beats) || b.beats.length > 10000 || b.beats.some(t => !Number.isFinite(t) || t < 0)) throw bad('RECIPE_INPUT');
    output.bgm = { path: b.path, volume: b.volume, duration: b.duration, beats: [...b.beats] };
  }
  if (input.brand?.enabled) {
    if (typeof input.brand.name !== 'string' || input.brand.name.length > 80 || !['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(input.brand.placement) ||
      (input.brand.logo !== null && !paths.has(input.brand.logo))) throw bad('RECIPE_INPUT');
    output.brand = { enabled: true, name: input.brand.name, placement: input.brand.placement, logo: input.brand.logo };
  }
  return output;
}

/** Extract only selected page clips and their direct local raster dependencies.
 * The caller supplies verified project-local reads; no directory walk occurs. */
export async function extractRecipe({ film, projectPath, selected, title, description = '', readLocal, brand = null, bgm = null }) {
  if (!film?.doc || !Array.isArray(selected) || !selected.length || selected.length > 32 || typeof readLocal !== 'function') throw bad('RECIPE_INPUT');
  const allowed = new Set(selected);
  const clips = film.doc.tracks.flatMap(track => track.clips).filter(clip => allowed.has(clip.id) && !isBrandPresentationClip(clip));
  if (clips.length !== allowed.size) throw bad('RECIPE_SELECTION');
  const assets = new Map();
  const addAsset = async (source, kind) => {
    if (!localPath(source)) throw bad('RECIPE_ASSET');
    const bytes = await readLocal(source);
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 32 * 1024 * 1024) throw bad('RECIPE_ASSET');
    const sha256 = hash(bytes);
    const ext = source.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
    if (!EXT.has(ext)) throw bad('RECIPE_ASSET');
    const path = `assets/${sha256}.${ext}`;
    assets.set(path, { path, sha256, bytes, kind });
    return path;
  };
  const scenes = [];
  for (const clip of clips) {
    if (kindOf(clip) !== 'page') throw bad('RECIPE_KIND');
    const source = clip.src.split('#')[0];
    if (!localPath(source) || !source.toLowerCase().endsWith('.html')) throw bad('RECIPE_ASSET');
    const raw = await readLocal(source);
    let document = raw.toString('utf8');
    const base = source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : '';
    const styles = [];
    const cssAssets = new Map();
    for (const match of document.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi)) {
      const ref = match[1];
      if (typeof ref !== 'string' || isAbsolute(ref) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) || ref.includes('\\') || ref.includes('\0') || !/\.css(?:[?#]|$)/i.test(ref)) throw bad('RECIPE_ASSET');
      const cssPath = posix.normalize(`${base}${ref}`);
      if (!localPath(cssPath)) throw bad('RECIPE_ASSET');
      const cssBase = cssPath.includes('/') ? cssPath.slice(0, cssPath.lastIndexOf('/') + 1) : '';
      const css = (await readLocal(cssPath)).toString('utf8');
      const resolve = image => {
        const normalized = posix.normalize(`${cssBase}${image}`);
        if (!localPath(normalized)) throw bad('RECIPE_ASSET');
        if (!cssAssets.has(normalized)) cssAssets.set(normalized, `assets/css-${cssAssets.size}.${normalized.split('.').pop().toLowerCase()}`);
        return cssAssets.get(normalized);
      };
      styles.push(sanitizeRecipeCss(css, resolve));
    }
    for (const [path, target] of cssAssets) {
      const hashed = await addAsset(path, 'image');
      for (let i = 0; i < styles.length; i++) styles[i] = styles[i].replaceAll(target, hashed);
    }
    if (styles.length) document = document.replace(/<body\b[^>]*>/i, body => `${body}\n<style>${styles.join('\n')}</style>`);
    const safe = sanitizeRecipeScene(document, { prefix: clip.id });
    if (!safe.html.trimStart().startsWith('<')) throw bad('RECIPE_KIND');
    const remap = {};
    for (const [original, target] of Object.entries(safe.assets)) remap[target] = original === target ? target : await addAsset(posix.normalize(`${base}${original}`), 'image');
    let html = safe.html;
    const sceneAssets = {};
    for (const [original, target] of Object.entries(safe.assets)) {
      html = html.replaceAll(target, remap[target]);
      sceneAssets[remap[target]] = remap[target];
    }
    const duration = clipSpan(clip).length;
    scenes.push({ id: clip.id, title: clip.title || clip.id, duration, html, labels: safe.labels, assets: sceneAssets });
  }
  const ratio = film.doc.stage.h > film.doc.stage.w ? '9:16' : film.doc.stage.w > film.doc.stage.h ? '16:9' : '1:1';
  const recipe = { version: RECIPE_VERSION, id: 'local-recipe', title, description, canvas: { w: film.doc.stage.w, h: film.doc.stage.h, ratio }, scenes, assets: [] };
  if (bgm?.path) recipe.bgm = { path: await addAsset(bgm.path, 'audio'), volume: Math.max(0, Math.min(1, Number(bgm.volume) || 0)), duration: Number(bgm.duration), beats: Array.isArray(bgm.beats) ? bgm.beats : [] };
  const visibleBrand = brandForScene(brand);
  if (visibleBrand) {
    const logo = visibleBrand.logo ? await addAsset(visibleBrand.logo, 'image') : null;
    recipe.brand = { enabled: true, name: visibleBrand.name, placement: visibleBrand.placement, logo };
  }
  recipe.assets = [...assets.values()].map(({ bytes, ...meta }) => meta);
  const normalized = normalizeRecipe(recipe);
  const result = { ...normalized, id: `local-${hash(Buffer.from(JSON.stringify(normalized))).slice(0, 12)}` };
  Object.defineProperty(result, RECIPE_ASSET_BYTES, { value: new Map([...assets].map(([path, asset]) => [path, asset.bytes])) });
  return result;
}

function fillLabels(html, labels) {
  return html.replace(/\{\{([A-Za-z][A-Za-z0-9_-]*)\}\}/g, (_, id) => escapeHtml(labels[id] ?? `{{${id}}}`));
}

export function recipeProjectFiles(recipe, { motionRuntime, title } = {}) {
  const safe = normalizeRecipe(recipe);
  if (typeof motionRuntime !== 'string' || motionRuntime.length > 100_000) throw bad('RECIPE_INPUT');
  const files = new Map([['assets/motion.js', motionRuntime]]);
  for (const asset of safe.assets) files.set(asset.path, null); // Filled by the library/store, never by imported paths.
  const wall = safe.scenes.map(scene => ({ id: scene.id, title: scene.title, start: 0, duration: scene.duration }));
  let cursor = 0;
  for (const scene of wall) { scene.start = cursor; cursor += scene.duration; }
  for (const scene of safe.scenes) {
    const source = fillLabels(scene.html, scene.labels);
    files.set(`pages/${scene.id}.html`, page({ title: scene.title, size: [safe.canvas.w, safe.canvas.h], scripts: ['../assets/motion.js'],
      body: `<main data-recipe-scene="${scene.id}">${source}</main>`,
      script: `window.film={width:${safe.canvas.w},height:${safe.canvas.h},duration:${scene.duration},ready:Promise.resolve(document.fonts?.ready),frame:function(){}};` }));
  }
  const audio = safe.bgm ? [{ id: 'bgm', title: '背景音乐', clips: [{ src: safe.bgm.path, at: 0, duration: Math.min(cursor, safe.bgm.duration), volume: safe.bgm.volume }] }] : [];
  files.set('film.html', shotWall({ title: title || safe.title, size: [safe.canvas.w, safe.canvas.h], shots: wall, audioTracks: audio, sectionTitle: `${safe.title} · 配方` }));
  files.set('.film/recipe.json', `${JSON.stringify(safe, null, 2)}\n`);
  if (safe.bgm) files.set('.film/rhythm.json', `${JSON.stringify({ version: 1, source: safe.bgm.path, analysis: { beats: safe.bgm.beats.map(t => t * 1000) } }, null, 2)}\n`);
  return files;
}

/** Share is a separate, private-by-default projection of the same data recipe. */
export function shareRecipe(recipe, { includeBrand = false, includeBgm = false } = {}) {
  const safe = normalizeRecipe(recipe);
  if (!includeBrand) delete safe.brand;
  if (!includeBgm) delete safe.bgm;
  const used = new Set(safe.scenes.flatMap(scene => Object.values(scene.assets)));
  if (safe.bgm) used.add(safe.bgm.path);
  if (safe.brand?.logo) used.add(safe.brand.logo);
  safe.assets = safe.assets.filter(asset => used.has(asset.path));
  return safe;
}
