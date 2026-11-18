// The built-in library search the Host does itself.
//
// OpenFilm 0.4.0 narrowed the agent-facing `openfilm get` verbs to music, sounds
// and stickers: transitions, effects, filters, texts and templates became the
// person's to pick in Studio. This plugin still lets the agent find one of those
// and put it over a cut (that is a shipped behaviour, see docs/STATE.md), so for
// those kinds the Host searches the pinned package's own library in process,
// with the pinned library's own scoring, and prints the same shape of answer the
// Studio route would have printed. Nothing is copied here: `take` still goes
// through Studio's `saved/take`.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** The kinds 0.4.0 still answers through `/api/get/library`. */
export const AGENT_VERBS = Object.freeze({ music: 'music-search', sound: 'sfx-search', sticker: 'sticker' });

const BUILT_IN = 'openfilm';

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

/**
 * Search the built-in library for a kind the Studio route no longer serves.
 * Returns the same `{ code, lines }` shape `/api/get/library` answers with, so
 * the tool's text handling stays in one place.
 * @param {string} kind one of transition, effect, filter, text, template
 * @param {string} query what to look for
 * @param {{ limit?: number }} [options]
 */
export async function searchBuiltInLibrary(kind, query, options = {}) {
  const module = await loadBuiltInSearch();
  if (!module) {
    return { code: 2, lines: [`The pinned OpenFilm library could not be loaded, so ${kind} cannot be searched here. Studio's assets drawer can still take one.`] };
  }
  const limit = Number.isSafeInteger(options.limit) ? options.limit : 8;
  const { found, worded } = await module.searchLibrary(kind, query, { limit });
  if (!found.length) {
    return { code: 0, lines: [`Nothing in OpenFilm's library for “${query}”: write it in the film yourself, as a page or CSS.`] };
  }
  const lines = [worded
    ? `${found.length} in OpenFilm's library for “${query}”, the best first (free to use in any film):`
    : `No words of “${query}” are in OpenFilm's library; the ${found.length} nearest in meaning, which may not fit:`, ''];
  found.forEach(/** @param {any} entry @param {number} index */ (entry, index) => {
    const item = entry.item ?? {};
    const zh = item.name?.zh ?? item.name?.['zh-CN'];
    const name = item.name?.en ? `${item.name.en}${zh ? ` (${zh})` : ''}` : (zh ?? item.id);
    const facts = [item.durationMs ? clock(item.durationMs) : null, item.place ? `place: ${item.place}` : null].filter(Boolean).join(' · ');
    lines.push(`${String(index + 1).padStart(2)}. ${name}${facts ? `   ${facts}` : ''}`);
    lines.push(`    ${BUILT_IN}/${item.id}`);
    if (item.about) lines.push(`    ${item.about}`);
    if (Array.isArray(entry.tags) && entry.tags.length) lines.push(`    ${entry.tags.slice(0, 8).join(', ')}`);
  });
  lines.push('', `Take one into the film: pass take=<id> with the ${BUILT_IN}/ id above.`);
  return { code: 0, lines };
}
