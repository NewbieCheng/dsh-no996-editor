import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { clipSpan, kindOf, readFilmFile } from '../../vendor/film-doc.mjs';
import { extractRecipe, recipeProjectFiles, RECIPE_ASSET_BYTES, shareRecipe } from '../film/template-recipe.mjs';
import { readRecipeZip, writeRecipeZip } from '../film/recipe-zip.mjs';
import { isBrandPresentationClip, readProjectBrand } from '../film/project-brand.mjs';

export const RECIPE_RPC_CHANNELS = ['template:recipe-preview', 'template:recipe-save', 'template:local-list', 'template:local-get',
  'template:local-delete', 'template:local-import', 'template:local-export', 'template:local-create', 'template:market-get', 'template:market-set', 'template:market-refresh', 'template:market-install'];
const bad = code => Object.assign(new Error(code), { code });
const motionRuntime = readFileSync(new URL('../../packages/no996-motion-runtime/browser/no996-motion.js', import.meta.url), 'utf8');
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)); };
const idOkay = value => typeof value === 'string' && /^[a-z][a-z0-9-]{2,63}$/.test(value);
function marketUrl(value) {
  if (typeof value !== 'string' || value.length > 1000 || !/^https:\/\/[^\s]+$/i.test(value)) return null;
  try {
    const parsed = new URL(value);
    return parsed.username || parsed.password ? null : parsed.href;
  } catch { return null; }
}
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');

async function savedFilm(projectPath) {
  const root = await realpath(projectPath), file = join(root, 'film.html');
  if (resolve(await realpath(file)) !== resolve(file)) throw bad('RECIPE_FILM');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw bad('RECIPE_FILM');
  const bytes = await readFile(file), result = readFilmFile(bytes.toString('utf8'));
  if (!result.doc || result.problems.length) throw bad('RECIPE_FILM');
  return { root, film: result, hash: fingerprint(bytes) };
}

function projectReader(root) {
  return async relativePath => {
    if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.includes('\0') || relativePath.split('/').includes('..')) throw bad('RECIPE_ASSET');
    const file = join(root, relativePath);
    if (!inside(root, resolve(file)) || resolve(await realpath(file)) !== resolve(file)) throw bad('RECIPE_ASSET');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw bad('RECIPE_ASSET');
    return readFile(file);
  };
}

async function selectedBgm(film, root, payload) {
  if (!payload.bgmClipId) return null;
  const clip = film.doc.tracks.flatMap(track => track.clips).find(item => item.id === payload.bgmClipId);
  if (!clip || kindOf(clip) !== 'sound' || clip.disabled) throw bad('RECIPE_BGM');
  const duration = clipSpan(clip).length;
  if (!Number.isFinite(duration) || duration <= 0) throw bad('RECIPE_BGM');
  let beats = [];
  try {
    const rhythm = JSON.parse(await readFile(join(root, '.film', 'rhythm.json'), 'utf8'));
    if (rhythm.source === clip.src.split('#')[0] && Array.isArray(rhythm.analysis?.beats)) beats = rhythm.analysis.beats.filter(Number.isFinite).map(value => value / 1000);
  } catch { /* No measured rhythm is better than invented beat sync. */ }
  return { path: clip.src.split('#')[0], volume: Number.isFinite(clip.volume) ? clip.volume : 1, duration, beats };
}

async function fetchMarketZip(url, expectedSha256, fetchImpl) {
  if (!marketUrl(url)) throw bad('RECIPE_MARKET');
  let response;
  try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/zip,application/octet-stream' } }); }
  catch { throw bad('RECIPE_MARKET_UNAVAILABLE'); }
  if (!response.ok || Number(response.headers.get('content-length')) > 64 * 1024 * 1024) throw bad('RECIPE_MARKET_UNAVAILABLE');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw bad('RECIPE_MARKET_UNAVAILABLE');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) { if (error?.code) throw error; throw bad('RECIPE_MARKET_UNAVAILABLE'); }
  const bytes = Buffer.concat(chunks);
  if (fingerprint(bytes) !== expectedSha256) throw bad('RECIPE_MARKET_HASH');
  return bytes;
}

export function createTemplateRecipeRpc({ store, preferences, verifyProject, projectParent, createProject, fetchImpl = globalThis.fetch }) {
  const pending = new Map();
  return async (channel, payload, projectContext) => {
    if (channel === 'template:local-list') return { templates: await store.list() };
    if (channel === 'template:local-get') {
      if (!idOkay(payload?.id)) throw bad('RECIPE_INPUT');
      return { recipe: shareRecipe(await store.get(payload.id)) };
    }
    if (channel === 'template:local-delete') {
      if (!idOkay(payload?.id)) throw bad('RECIPE_INPUT');
      return store.remove(payload.id);
    }
    if (channel === 'template:local-import') {
      if (typeof payload?.zipBase64 !== 'string' || payload.zipBase64.length > 8 * 1024 * 1024) throw bad('RECIPE_ZIP_INPUT');
      const zip = Buffer.from(payload.zipBase64, 'base64');
      if (zip.toString('base64') !== payload.zipBase64) throw bad('RECIPE_ZIP_INPUT');
      const recipe = readRecipeZip(zip);
      await store.save(recipe);
      return { id: recipe.id };
    }
    if (channel === 'template:local-export') {
      if (!idOkay(payload?.id)) throw bad('RECIPE_INPUT');
      const recipe = shareRecipe(await store.get(payload.id), { includeBrand: payload.includeBrand === true, includeBgm: payload.includeBgm === true });
      const zip = writeRecipeZip(recipe);
      if (zip.length > 6 * 1024 * 1024) throw bad('RECIPE_EXPORT_TOO_LARGE');
      return { zipBase64: zip.toString('base64'), fileName: `${recipe.id}.no996-template.zip` };
    }
    if (channel === 'template:local-create') {
      if (!idOkay(payload?.id) || !['9:16', '16:9', '1:1'].includes(payload.ratio) || typeof createProject !== 'function') throw bad('RECIPE_INPUT');
      const recipe = await store.get(payload.id);
      if (recipe.canvas.ratio !== payload.ratio) throw bad('RECIPE_RATIO');
      const files = recipeProjectFiles(recipe, { motionRuntime });
      const parent = await projectParent(projectContext);
      await mkdir(parent, { recursive: true });
      const slug = recipe.title.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'template';
      const target = join(parent, `${slug}-${randomBytes(6).toString('hex')}`);
      await mkdir(target);
      try {
        for (const [path, body] of files) {
          const content = body ?? recipe[RECIPE_ASSET_BYTES].get(path);
          const bytes = Buffer.isBuffer(content) ? content : typeof content === 'string' ? Buffer.from(content) : null;
          if (!bytes) throw bad('RECIPE_ASSET');
          const file = join(target, path);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, bytes, { flag: 'wx' });
        }
      } catch (error) { await rm(target, { recursive: true, force: true }).catch(() => {}); throw error; }
      const project = await createProject(target, projectContext);
      if (!/^[A-Za-z0-9_-]{6,40}$/.test(project?.id ?? '')) throw bad('TEMPLATE_REGISTRATION_UNCERTAIN');
      return { projectId: project.id };
    }
    if (channel === 'template:market-get') return { market: (await preferences.get()).templateMarket };
    if (channel === 'template:market-set') {
      const url = payload?.url ?? '';
      const safe = url ? marketUrl(url) : '';
      if (url && !safe) throw bad('RECIPE_MARKET');
      return { market: (await preferences.set({ templateMarket: { url: safe, refreshedAt: '', items: [] } })).templateMarket };
    }
    if (channel === 'template:market-refresh') {
      const market = (await preferences.get()).templateMarket;
      if (!market.url) throw bad('RECIPE_MARKET_UNAVAILABLE');
      let response;
      if (!marketUrl(market.url)) throw bad('RECIPE_MARKET');
      try { response = await fetchImpl(market.url, { redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } }); }
      catch { throw bad('RECIPE_MARKET_UNAVAILABLE'); }
      if (!response.ok || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw bad('RECIPE_MARKET_UNAVAILABLE');
      let text;
      try { text = await response.text(); } catch { throw bad('RECIPE_MARKET_UNAVAILABLE'); }
      if (text.length > 2 * 1024 * 1024) throw bad('RECIPE_MARKET_UNAVAILABLE');
      let data;
      try { data = JSON.parse(text); } catch { throw bad('RECIPE_MARKET_UNAVAILABLE'); }
      if (data?.version !== 1 || !Array.isArray(data.templates) || data.templates.length > 100) throw bad('RECIPE_MARKET_UNAVAILABLE');
      const ids = new Set();
      const items = data.templates.map(item => {
        const url = marketUrl(item?.url);
        if (!idOkay(item?.id) || ids.has(item.id) || typeof item.title !== 'string' || !item.title.trim() || !url || !/^[a-f0-9]{64}$/.test(item.sha256)) throw bad('RECIPE_MARKET_UNAVAILABLE');
        ids.add(item.id);
        return { id: item.id, title: item.title.slice(0, 80), description: typeof item.description === 'string' ? item.description.slice(0, 400) : '', url, sha256: item.sha256 };
      });
      return { market: (await preferences.set({ templateMarket: { url: market.url, refreshedAt: new Date().toISOString(), items } })).templateMarket };
    }
    if (channel === 'template:market-install') {
      if (!idOkay(payload?.id)) throw bad('RECIPE_INPUT');
      const item = (await preferences.get()).templateMarket.items.find(entry => entry.id === payload.id);
      if (!item) throw bad('RECIPE_MARKET_UNAVAILABLE');
      const recipe = readRecipeZip(await fetchMarketZip(item.url, item.sha256, fetchImpl));
      if (recipe.id !== item.id) throw bad('RECIPE_MARKET_HASH');
      await store.save(recipe);
      return { id: recipe.id };
    }
    if (!['template:recipe-preview', 'template:recipe-save'].includes(channel)) throw bad('RECIPE_INPUT');
    const project = await verifyProject(payload?.projectId);
    const { root, film, hash } = await savedFilm(project.path);
    if (channel === 'template:recipe-preview') {
      const clips = film.doc.tracks.flatMap(track => track.clips).flatMap(clip => {
        if (clip.disabled || isBrandPresentationClip(clip)) return [];
        try {
          const duration = clipSpan(clip).length;
          return Number.isFinite(duration) && duration > 0 ? [{ id: clip.id, title: clip.title || clip.id, kind: kindOf(clip), duration }] : [];
        } catch { return []; }
      });
      const brand = await readProjectBrand(root).catch(() => null);
      const previewToken = randomBytes(18).toString('hex');
      for (const [key, value] of pending) if (value.expiresAt <= Date.now()) pending.delete(key);
      if (pending.size >= 8) throw bad('RECIPE_PREVIEW_BUSY');
      pending.set(previewToken, { projectId: project.projectId, hash, expiresAt: Date.now() + 5 * 60_000 });
      return { projectId: project.projectId, previewToken, canvas: film.doc.stage, clips, brand: brand?.mode === 'snapshot' && brand.enabled ? { name: brand.name, placement: brand.placement, hasLogo: Boolean(brand.logo) } : null };
    }
    const expected = pending.get(payload?.previewToken);
    if (!expected || expected.projectId !== project.projectId || expected.hash !== hash) throw bad('RECIPE_PREVIEW_STALE');
    const selected = payload.selected;
    if (!Array.isArray(selected) || !selected.length || selected.length > 32 || new Set(selected).size !== selected.length || selected.some(id => typeof id !== 'string')) throw bad('RECIPE_SELECTION');
    if (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 80 || typeof payload.description !== 'string' || payload.description.length > 400) throw bad('RECIPE_INPUT');
    pending.delete(payload.previewToken);
    const recipe = await extractRecipe({ film, projectPath: root, selected, title: payload.title.trim(), description: payload.description.trim(),
      readLocal: projectReader(root), brand: payload.includeBrand === true ? await readProjectBrand(root) : null, bgm: await selectedBgm(film, root, payload) });
    await store.save(recipe);
    return { id: recipe.id, scenes: recipe.scenes.length, assets: recipe.assets.length };
  };
}
