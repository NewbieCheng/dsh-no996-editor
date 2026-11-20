// Search reads only manifests. Guidance remains data and is loaded by explicit ID.
import { lstat, open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RATIO = /^\d{1,4}:\d{1,4}$/;
const short = (value, size) => typeof value === 'string' ? value.trim().slice(0, size) : '';
const strings = (value, limit, size) => Array.isArray(value) ? value.slice(0, limit).map(v => short(v, size)).filter(Boolean) : [];
const directory = async path => (await lstat(path).catch(() => null))?.isDirectory() === true;

async function readBounded(path, limit, truncate = false) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || (!truncate && info.size > limit)) return '';
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)).catch(() => null);
  if (!file) return '';
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) return '';
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (!truncate && bytesRead > limit) return '';
    return buffer.subarray(0, Math.min(bytesRead, limit)).toString('utf8');
  } finally { await file.close(); }
}

async function readTemplate(root, id, source, detail) {
  if (!ID.test(id) || !await directory(join(root, id))) return undefined;
  const folder = join(root, id);
  let manifest;
  try { manifest = JSON.parse(await readBounded(join(folder, 'manifest.json'), 32_768)); } catch { return undefined; }
  if (!manifest || manifest.id !== id || !short(manifest.title, 60)) return undefined;
  const template = {
    id: source === 'external' ? `external:${id}` : id,
    source,
    title: short(manifest.title, 60),
    description: short(manifest.description, 240),
    mode: manifest.mode === 'film' ? 'film' : 'style',
    order: Number.isFinite(manifest.order) ? manifest.order : 100,
    featured: manifest.featured === true,
    tags: strings(manifest.tags, 8, 32),
    ratios: strings(manifest.ratios, 8, 12).filter(value => RATIO.test(value) && value.split(':').every(Number)),
    slots: strings(manifest.slots, 12, 48),
    dependencies: strings(manifest.dependencies, 12, 60),
    version: short(manifest.version, 40),
  };
  if (detail) template.prompt = (await readBounded(join(folder, 'prompt.md'), 8192, true)).trim().slice(0, 2048) || short(manifest.prompt, 2048);
  return template;
}

export async function templateCatalog(root, { source = 'bundled' } = {}) {
  if (typeof root !== 'string' || !root || !await directory(root)) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue;
    const template = await readTemplate(root, entry.name, source, false);
    if (template) found.push(template);
  }
  return found.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export async function templateDetails(root, id, { source = 'bundled' } = {}) {
  if (typeof root !== 'string' || !root || !await directory(root) || typeof id !== 'string') return undefined;
  return readTemplate(root, id, source, true);
}

export function scoreTemplate(template, query) {
  const words = String(query ?? '').slice(0, 240).toLowerCase().split(/[\s,，、/]+/).filter(Boolean);
  if (!words.length) return 1;
  const haystack = [template.id, template.title, template.description, ...(template.tags ?? []), ...(template.ratios ?? []), ...(template.slots ?? [])].join(' ').toLowerCase();
  return words.reduce((score, word) => score + Number(haystack.includes(word)), 0);
}

export function searchTemplates(catalog, query, limit = 5, { ratio, category } = {}) {
  return (Array.isArray(catalog) ? catalog : [])
    .filter(item => (!ratio || item.ratios?.includes(ratio)) && (!category || item.tags?.some(tag => tag.toLowerCase() === category.toLowerCase())))
    .map(template => ({ template, score: scoreTemplate(template, query) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.template.order ?? 100) - (b.template.order ?? 100) || a.template.id.localeCompare(b.template.id))
    .slice(0, Math.min(5, Math.max(1, Math.trunc(Number(limit) || 5))))
    .map(entry => entry.template);
}

export function catalogText(templates) {
  if (!templates.length) return '没有可用的模板。';
  return templates.map(template => {
    const facts = [template.source, ...(template.ratios ?? []), ...(template.tags ?? [])].filter(Boolean);
    return `· ${template.id} —— ${template.title}${template.description ? `：${template.description}` : ''}${facts.length ? ` [${facts.join(' · ')}]` : ''}`;
  }).join('\n');
}
