import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Mounted only inside `preset-openfilm-video-editing`, so these skills live
// strictly in that preset's scope and never enter general DSH conversations.
export const inject = ['skills'];

const defaultSkillsDir = () => join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

/** Parse minimal YAML frontmatter (`name`, `description`) and markdown body. */
function parseSkillMarkdown(raw, fallbackName) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const head = match ? match[1] : '';
  const body = (match ? match[2] : raw).trim();
  const name = (/^name:\s*(.+)$/m.exec(head)?.[1] ?? fallbackName).trim().replace(/^["']|["']$/g, '');
  const description = (/^description:\s*(.+)$/m.exec(head)?.[1] ?? name).trim().replace(/^["']|["']$/g, '');
  const whenToUse = (/^when_to_use:\s*(.+)$/m.exec(head)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  return {
    name,
    description: description || name,
    ...(whenToUse ? { whenToUse } : {}),
    content: body || raw,
  };
}

/**
 * Register every `SKILL.md` under `skillsDir` into the current Cordis scope.
 * @param {object} ctx - Preset-scoped Cordis context with `ctx.skills`
 * @param {{ skillsDir?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const dir = typeof config?.skillsDir === 'string' && config.skillsDir ? config.skillsDir : defaultSkillsDir();
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const disposers = [];
  for (const entry of entries) {
    const skillDir = join(dir, entry.name);
    const file = join(skillDir, 'SKILL.md');
    if (!existsSync(file)) continue;
    const raw = readFileSync(file, 'utf8');
    const parsed = parseSkillMarkdown(raw, entry.name);
    disposers.push(ctx.skills.register({
      ...parsed,
      path: file,
      source: 'bundled',
      resourceBase: { kind: 'directory', path: skillDir },
    }));
  }
  return () => {
    for (const dispose of disposers) {
      try { dispose?.(); } catch { /* already disposed */ }
    }
  };
}
