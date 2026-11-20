// Template prompts: how "this film is a sketchnote explainer" reaches the agent.
//
// A template is not only a starting `film.html`; it also carries a point of view —
// palette, shot grammar, what the on-screen text sounds like. That point of view is
// `vendor/templates/<id>/prompt.md`, and it must reach the conversation that is
// editing *that* project, without living in the system prompt of every project.
//
// So a template is *activated* per project:
//
//   .film/templates.json   { "version": 1, "active": ["sketchnote", "vibe-explainer"] }
//
// and the active prompts are rendered into the project's `AGENTS.md` inside a block
// this Host owns:
//
//   <!-- no996-openfilm:templates:begin -->
//   … one section per active template, in order …
//   <!-- no996-openfilm:templates:end -->
//
// Only a byte-identical plugin-owned file or one matching our last-write receipt
// may be rewritten. A custom or subsequently edited file is never changed. The
// activation tool returns the prompt in its result for the current turn.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { INSTRUCTIONS } from '../project/project-instructions.mjs';
import { dirname, join } from 'node:path';

export const TEMPLATES_FILE = join('.film', 'templates.json');
export const BLOCK_BEGIN = '<!-- no996-openfilm:templates:begin -->';
export const BLOCK_END = '<!-- no996-openfilm:templates:end -->';
/** One template's prompt, as injected. Longer than this is a manual, not a prompt. */
export const PROMPT_MAX = 2048;
/** A template id, as a folder name. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The whole generated block: several templates may be active at once. */
export const BLOCK_MAX = 8 * 1024;

/** The ids this project has active, in order (deduplicated, bounded). */
export function readActiveTemplates(projectPath, fs = { readFileSync, existsSync }) {
  try {
    const file = join(projectPath, TEMPLATES_FILE);
    if (!fs.existsSync(file)) return [];
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(value?.active) ? value.active : [];
    return [...new Set(list.filter(id => typeof id === 'string' && ID.test(id)))].slice(0, 12);
  } catch { return []; }
}

/** Persist the active list (temp + rename: a half-written file must not be read). */
export function writeActiveTemplates(projectPath, ids, fs = { writeFileSync, mkdirSync, renameSync }) {
  const file = join(projectPath, TEMPLATES_FILE);
  fs.mkdirSync(dirname(file), { recursive: true });
  const active = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && ID.test(id)))].slice(0, 12);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, active }, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return active;
}

/**
 * The generated block for the active templates.
 *
 * Each section is "title (id)" then the prompt. A template with no prompt still gets
 * a section: "this project was made from it" is itself information the agent needs
 * (its `film.html` layout is that template's).
 */
export function renderTemplateBlock(templates = []) {
  const list = (Array.isArray(templates) ? templates : []).filter(item => item && typeof item.id === 'string');
  if (list.length === 0) return '';
  const sections = [];
  let budget = BLOCK_MAX;
  for (const template of list) {
    const title = typeof template.title === 'string' && template.title.trim() ? template.title.trim() : template.id;
    const raw = typeof template.prompt === 'string' ? template.prompt.trim() : '';
    const prompt = raw.length > PROMPT_MAX ? `${raw.slice(0, PROMPT_MAX)}…` : raw;
    const heading = `### ${title}（${template.id}）`;
    const body = prompt || '这个模板没有额外说明；按它的 film.html 版式继续。';
    const section = `${heading}\n\n${body}`;
    if (section.length + 2 > budget) break;
    budget -= section.length + 2;
    sections.push(section);
  }
  return [
    BLOCK_BEGIN,
    '## 本片使用的模板',
    '',
    '下面是这个项目选用的模板说明：它们描述这支片的设定与思路，冲突时优先于通用做法。模板之外的需求以对方的话为准。',
    '',
    sections.join('\n\n'),
    BLOCK_END,
  ].join('\n');
}

/**
 * Put `block` into `text` in place of the previous generated block.
 *
 * No block yet → the block is appended (a project written before templates existed).
 * No templates → the previous block is removed, so deactivating one really removes
 * its prompt instead of leaving it behind.
 */
export function withTemplateBlock(text, block) {
  const source = String(text ?? '');
  const begin = source.indexOf(BLOCK_BEGIN);
  const end = source.indexOf(BLOCK_END);
  const hasBlock = begin >= 0 && end > begin;
  if (!block) {
    if (!hasBlock) return source;
    const head = source.slice(0, begin).replace(/\s+$/, '');
    const tail = source.slice(end + BLOCK_END.length).replace(/^\s+/, '');
    return `${head}${tail ? `\n\n${tail}` : ''}\n`;
  }
  if (!source.trim()) return `${block}\n`;
  if (!hasBlock) return `${source.replace(/\s+$/, '')}\n\n${block}\n`;
  return `${source.slice(0, begin)}${block}${source.slice(end + BLOCK_END.length)}`;
}

/** Read the templates and write the block into the project's AGENTS.md. */
export function syncTemplateBlock(projectPath, templates, fs = { readFileSync, writeFileSync, existsSync, mkdirSync }) {
  const file = join(projectPath, 'AGENTS.md');
  let current;
  try { current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; } catch { return { changed: false, file, reason: 'unreadable' }; }
  if (current === null) return { changed: false, file, reason: 'missing' };
  const receipt = join(projectPath, '.film', 'template-instructions.sha256');
  const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
  let previous = '';
  try { previous = fs.existsSync(receipt) ? fs.readFileSync(receipt, 'utf8').trim() : ''; } catch { /* no ownership evidence */ }
  if (current !== INSTRUCTIONS && (!previous || hash(current) !== previous)) {
    return { changed: false, file, reason: 'user-owned' };
  }
  const next = withTemplateBlock(current, renderTemplateBlock(templates));
  if (next === current) return { changed: false, file, reason: 'current' };
  fs.mkdirSync(dirname(receipt), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  // If recording ownership fails, future updates safely leave the file alone.
  fs.writeFileSync(receipt, `${hash(next)}\n`, 'utf8');
  return { changed: true, file };
}

/** Which block the file currently carries, for tests and diagnose. */
export function templateBlockOf(text) {
  const source = String(text ?? '');
  const begin = source.indexOf(BLOCK_BEGIN);
  const end = source.indexOf(BLOCK_END);
  if (begin < 0 || end <= begin) return '';
  return source.slice(begin + BLOCK_BEGIN.length, end).trim();
}
