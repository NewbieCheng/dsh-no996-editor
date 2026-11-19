// The built-in library search the Host does itself.
//
// OpenFilm 0.4.0 narrowed the agent-facing `openfilm get` verbs to music, sounds
// and stickers: transitions, effects, filters, wordart, textmotion, motions,
// layers and templates are searched by the Host directly from the pinned package's
// offline index (`libraryIndex` + `searchLibrary`), plus `inspect` reads their full
// CSS vars / grade LUT / @keyframes / multi-track structure without touching disk.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadBuiltInLibraryModule } from '../film/library-presets.mjs';

const require = createRequire(import.meta.url);

/** The kinds 0.4.0 answers through `/api/get/library`. */
export const AGENT_VERBS = Object.freeze({ music: 'music-search', sound: 'sfx-search', sticker: 'sticker' });

const BUILT_IN = 'openfilm';
const BROWSE_WORDS = new Set(['*', 'all', 'list', '全部', '所有', '列表', '参考']);

let loaded;

/** Load the pinned package's own search, resolving the deep path it is not exported under. */
export async function loadBuiltInSearch() {
  if (loaded !== undefined) return loaded;
  try {
    const pkg = dirname(require.resolve('openfilm/package.json'));
    const module = await import(pathToFileURL(join(pkg, 'src', 'library-search.mjs')).href);
    loaded = typeof module.searchLibrary === 'function' ? module : null;
  } catch {
    loaded = null;
  }
  return loaded;
}

const clock = ms => {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
};

function supplyBadge(item) {
  if (!item) return '[本地免联网]';
  if (item.id?.startsWith('audio/') || item.id?.startsWith('stickers/emoji/') || item.id?.startsWith('community/')) {
    return '[首用按需联网缓存]';
  }
  if (item.kind === 'group' && item.music) return '[结构本地 · 配乐按需联网]';
  return '[本地免联网]';
}

function itemLabel(item) {
  const zh = item.name?.['zh-CN'] ?? item.name?.zh;
  return item.name?.en ? `${item.name.en}${zh ? ` (${zh})` : ''}` : (zh ?? item.id);
}

function formatEntryLines(entry, index, lines) {
  const item = entry.item ?? {};
  const facts = [
    item.kind ? `type:${item.kind}` : null,
    item.durationMs ? clock(item.durationMs) : null,
    item.place ? `place:${item.place}` : null,
    item.slots ? `${item.slots} slots` : null,
    supplyBadge(item),
  ].filter(Boolean).join(' · ');
  lines.push(`${String(index + 1).padStart(2)}. ${itemLabel(item)}${facts ? `   ${facts}` : ''}`);
  lines.push(`    ${BUILT_IN}/${item.id}`);
  if (item.about) lines.push(`    ${item.about}`);
  if (item.kind === 'textstyle' && item.vars) {
    const keys = Object.keys(item.vars).filter(k => k !== '--font').slice(0, 6);
    if (keys.length) lines.push(`    CSS 变量: ${keys.map(k => `${k}=${item.vars[k]}`).join(' ; ').slice(0, 140)}`);
  }
  if (Array.isArray(entry.tags) && entry.tags.length) lines.push(`    ${entry.tags.slice(0, 8).join(', ')}`);
}

function scoreDirectItem(item, words) {
  if (!words.length) return 1;
  const hay = [
    item.id,
    item.cat,
    item.group,
    item.kind,
    item.name?.en,
    item.name?.['zh-CN'],
    item.name?.zh,
    item.about,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ].filter(Boolean).join(' ').toLowerCase();
  let score = 0;
  for (const w of words) if (hay.includes(w)) score += 1;
  return score;
}

async function searchFilteredCatalog(predicate, query, limit, label) {
  const lib = await loadBuiltInLibraryModule();
  if (!lib) return null;
  const index = lib.libraryIndex();
  const candidates = (Array.isArray(index?.items) ? index.items : []).filter(predicate);
  const trimmed = String(query ?? '').trim();
  const browse = !trimmed || BROWSE_WORDS.has(trimmed.toLowerCase());
  const words = browse ? [] : trimmed.toLowerCase().split(/[\s,，、/]+/).filter(Boolean);
  let hits = candidates
    .map(item => ({ item, tags: item.tags ?? [], score: scoreDirectItem(item, words) }))
    .filter(row => browse || row.score > 0)
    .sort((a, b) => b.score - a.score || String(a.item.id).localeCompare(String(b.item.id)))
    .slice(0, limit);
  let worded = hits.length > 0;
  if (!hits.length && candidates.length) {
    hits = candidates.slice(0, limit).map(item => ({ item, tags: item.tags ?? [] }));
    worded = false;
  }
  if (!hits.length) return { code: 0, lines: [`库里暂无匹配的「${label}」条目。`] };
  const lines = [
    worded
      ? `${hits.length} built-in ${label} match(es) for “${trimmed || 'all'}”:`
      : `No exact word match for “${trimmed}” in ${label}; showing ${hits.length} available entries:`,
    '',
  ];
  hits.forEach((entry, index) => formatEntryLines(entry, index, lines));
  lines.push('', '查看参数配方 (支持直接引用或写入参考): pass inspect="<openfilm/ id>".', '启用/取用到项目: pass take="<openfilm/ id>".');
  return { code: 0, lines };
}

/**
 * Search OpenFilm's built-in 14 multi-track templates (`cat === 'template'`).
 * Returns structured items for hybrid template listing with No996 templates.
 */
export async function searchBuiltInTemplates(query, limit = 5) {
  const lib = await loadBuiltInLibraryModule();
  const mod = await loadBuiltInSearch();
  if (!lib) return [];
  const trimmed = String(query ?? '').trim();
  const browse = !trimmed || BROWSE_WORDS.has(trimmed.toLowerCase());
  if (!browse && mod && typeof mod.findInLibrary === 'function') {
    const found = mod.findInLibrary('template', trimmed, { limit });
    if (Array.isArray(found) && found.length) return found.map(entry => entry.item);
  }
  const index = lib.libraryIndex();
  const templates = (Array.isArray(index?.items) ? index.items : []).filter(item => item?.cat === 'template');
  const words = browse ? [] : trimmed.toLowerCase().split(/[\s,，、/]+/).filter(Boolean);
  return templates
    .map(item => ({ item, score: scoreDirectItem(item, words) }))
    .filter(entry => browse || entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.item.id).localeCompare(String(b.item.id)))
    .slice(0, limit)
    .map(entry => entry.item);
}

/**
 * Search the built-in library for a kind the Studio route no longer serves
 * (or specialized sub-views: `wordart`, `textmotion`, `motion`, `layer`).
 * Returns the same `{ code, lines }` shape `/api/get/library` answers with.
 * @param {string} kind
 * @param {string} query
 * @param {{ limit?: number }} [options]
 */
export async function searchBuiltInLibrary(kind, query, options = {}) {
  const limit = Number.isSafeInteger(options.limit) ? options.limit : 8;
  if (kind === 'wordart') {
    const res = await searchFilteredCatalog(item => item?.cat === 'text' && item?.kind === 'textstyle', query, limit, 'wordart (花字库)');
    if (res) return res;
  }
  if (kind === 'textmotion') {
    const res = await searchFilteredCatalog(item => item?.cat === 'text' && item?.kind === 'textmotion', query, limit, 'textmotion (文字动效)');
    if (res) return res;
  }
  if (kind === 'motion') {
    const res = await searchFilteredCatalog(item => item?.kind === 'motion', query, limit, 'motion (关键帧动效/推移)');
    if (res) return res;
  }
  if (kind === 'layer') {
    const res = await searchFilteredCatalog(item => item?.cat === 'layer', query, limit, 'layer (图形图层)');
    if (res) return res;
  }

  const module = await loadBuiltInSearch();
  if (!module) {
    return { code: 2, lines: [`The pinned OpenFilm library could not be loaded, so ${kind} cannot be searched here. Studio's assets drawer can still take one.`] };
  }

  const trimmed = String(query ?? '').trim();
  if (BROWSE_WORDS.has(trimmed.toLowerCase())) {
    const res = await searchFilteredCatalog(item => item?.cat === kind, '', limit, kind);
    if (res) return res;
  }

  const { found, worded } = await module.searchLibrary(kind, query, { limit });
  if (!found.length) {
    return { code: 0, lines: [`Nothing in OpenFilm's library for “${query}”: write it in the film yourself, as a page or CSS.`] };
  }
  const lines = [worded
    ? `${found.length} in OpenFilm's library for “${query}”, the best first (free to use in any film):`
    : `No words of “${query}” are in OpenFilm's library; the ${found.length} nearest in meaning, which may not fit:`, ''];
  found.forEach((entry, index) => formatEntryLines(entry, index, lines));
  lines.push('', 'Inspect CSS/LUT recipe: pass inspect="<openfilm/ id>".', `Take one into the film: pass take=<id> with the ${BUILT_IN}/ id above.`);
  return { code: 0, lines };
}
