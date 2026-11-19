// The template catalog, as the agent can see it.
//
// Templates were invisible to the conversation: the only way to learn "what can this
// app make" was to open Studio's onboarding and look. So an agent asked for "a
// sketchnote explainer" invented one instead of using the template that exists.
//
// Two things live here: a searchable list (id, title, description, tags, when to use)
// and the per-template instruction snippet (`prompt.md`, at most 2 KB) that is handed
// over only when that template is actually chosen — the same rule as skills: knowledge
// on demand, not in the system prompt.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_PROMPT = 2048;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Everything the catalog knows about one template folder. */
async function readTemplate(root, id) {
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, id, 'manifest.json'), 'utf8')); } catch { return undefined; }
  if (!manifest || manifest.id !== id || typeof manifest.title !== 'string') return undefined;
  let prompt = '';
  try {
    prompt = (await readFile(join(root, id, 'prompt.md'), 'utf8')).slice(0, MAX_PROMPT).trim();
  } catch { prompt = typeof manifest.prompt === 'string' ? manifest.prompt.slice(0, MAX_PROMPT) : ''; }
  const tags = Array.isArray(manifest.tags) ? manifest.tags.filter(tag => typeof tag === 'string').slice(0, 8) : [];
  const order = typeof manifest.order === 'number' && Number.isFinite(manifest.order) ? manifest.order : 100;
  return {
    id,
    title: manifest.title.slice(0, 60),
    description: typeof manifest.description === 'string' ? manifest.description.slice(0, 240) : '',
    mode: manifest.mode === 'film' ? 'film' : 'style',
    order,
    ...(manifest.featured === true ? { featured: true } : {}),
    ...(tags.length ? { tags } : {}),
    ...(prompt ? { prompt } : {}),
  };
}

/**
 * The templates under `root`, sorted by explicit order then id.
 *
 * @param {string} root - the templates directory
 */
export async function templateCatalog(root) {
  if (typeof root !== 'string' || !root) return [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID.test(entry.name) || entry.name.startsWith('_')) continue;
    const template = await readTemplate(root, entry.name);
    if (template) found.push(template);
  }
  return found.sort((left, right) => (left.order ?? 100) - (right.order ?? 100) || left.id.localeCompare(right.id));
}

/** Score a template against a free-text query; 0 means "not a match". */
export function scoreTemplate(template, query) {
  const words = String(query ?? '').toLowerCase().split(/[\s,，、/]+/).filter(Boolean);
  if (words.length === 0) return 1;
  const haystack = [template.id, template.title, template.description, ...(template.tags ?? [])].join(' ').toLowerCase();
  let score = 0;
  for (const word of words) if (haystack.includes(word)) score += 1;
  return score;
}

/** The best matches, most relevant first. */
export function searchTemplates(catalog, query, limit = 5) {
  return (Array.isArray(catalog) ? catalog : [])
    .map(template => ({ template, score: scoreTemplate(template, query) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.template.id.localeCompare(right.template.id))
    .slice(0, Math.max(1, limit))
    .map(entry => entry.template);
}

/** One line per template: what a person needs to choose, without the prompt. */
export function catalogText(templates) {
  if (!templates.length) return '没有可用的模板。';
  return templates.map(template => `· ${template.id} —— ${template.title}${template.description ? `：${template.description}` : ''}${template.tags?.length ? `（${template.tags.join('/')}）` : ''}`).join('\n');
}
