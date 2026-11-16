// The child's identity, instruction boundary and skill isolation,
// delivered as `--patch` overlays.
//
// Three things were wrong with the panel's agent before this file existed:
//
//   1. Its identity came from the acp profile: "You are a coding agent". A film
//      conversation answered like a developer tool, because it was told it was one.
//   2. Its instructions came from wherever DSH found `AGENTS.md`, and DSH marks the
//      project root by `.git`. A film library living inside this plugin's repository
//      therefore injected *this repository's* developer manual into every film chat:
//      the agent recited "0.15.x / MIT / four UI layers" at someone asking for a cut.
//   3. Its skills came from the session-global catalog (`~40` entries: Office,
//      imagegen, every generic skill in `<dshHome>/skills`). The sidebar preset
//      `openfilm-video-editing` whitelists *tools*, but its `skill-filesystem`
//      entry keeps the defaults, so the skill directory summary alone cost ~4-5k
//      tokens in every film turn.
//
// All three are fixed here, in the child's own configuration, instead of asking the
// model to ignore what it was told:
//
//   · `system-prompt.personaPrefix` says who it is;
//   · `agent-instructions.projectRootMarkers` adds the markers every OpenFilm project
//     folder already has (`.film`, `film.html`), so the instruction chain starts at
//     the film folder and never reaches a repository above it;
//   · `skill-filesystem` drops the global roots (`includeDefaultRoots: false`) and
//     only watches this plugin's own `skills/` directory, so the only skills the
//     film agent can load are `openfilm-director` / `openfilm-editing` /
//     `openfilm-motion` (plus an explicit per-project escape hatch, if set).
//
// The full editing guidance is NOT duplicated here: it lives once in
// `src/acp/openfilm-prompt.mjs` (the same module the sidebar preset mounts as
// `openfilm-video-prompt`) and is inserted into the child via a second overlay
// (`writePromptOverlay`). This file carries identity + boundaries only.
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** What the panel's agent is. Short on purpose: identity, not a manual. */
export const PERSONA = [
  '你是 No996 Studio 的剪辑导演，用中文和用户说话。',
  '你交付的是能播的片子，不是代码：先说清楚这支片要干什么，再决定镜头、动效和节奏，最后才动 film.html。',
  '工具怎么用读 openfilm_guide；做片时按需加载 openfilm-motion 技能；用户丢视频过来时先转写口播再剪。',
].join('');

/**
 * Markers that make a film folder its own instruction root.
 *
 * `.film` is the project's own metadata folder and `film.html` the film itself, so
 * every OpenFilm project carries at least one — no file is created in the person's
 * folder to make this work, and `.git` stays first for ordinary checkouts.
 */
export const ROOT_MARKERS = ['.git', '.film', 'film.html'];

/**
 * Where the film-only skills live. Resolved from this file so the overlay never
 * hardcodes an install path: `<plugin>/skills` (openfilm-director,
 * openfilm-editing, openfilm-motion).
 */
export function defaultSkillsDir() {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
  } catch {
    return join('skills');
  }
}

/** Absolute file URL of the preset's prompt module, reused verbatim in the child. */
export function defaultPromptHref() {
  try {
    return pathToFileURL(fileURLToPath(new URL('./openfilm-prompt.mjs', import.meta.url))).href;
  } catch {
    return '';
  }
}

/**
 * The YAML of the overlay. `insert` is not used here: all three entries already
 * exist in the acp profile, so these are id-targeted overrides.
 *
 * `skill-filesystem` is the skill gate the preset never had: the preset
 * whitelists tools, but keeps the filesystem provider's defaults (global
 * `<dshHome>/skills` + `<agentsHome>/skills`, ~40 entries). The child sets
 * `includeDefaultRoots: false` and only watches this package's `skills/`, so
 * the ~4-5k skill-catalog block shrinks to the three editing skills. A
 * per-project escape hatch (`extraSkillDirs`, typically
 * `<project>/.agents/skills`) stays allowed without reopening the globals.
 *
 * @param {object} [options]
 * @param {string} [options.persona] - override for tests
 * @param {number} [options.maxBytes] - instruction budget, kept explicit
 * @param {string} [options.skillsDir] - isolated skill root (default: this package's skills/)
 * @param {string[]} [options.extraSkillDirs] - per-project additions, never the globals
 */
export function overlayYaml({ persona = PERSONA, maxBytes = 65536, skillsDir, extraSkillDirs = [] } = {}) {
  const markers = ROOT_MARKERS.map(marker => `        - ${JSON.stringify(marker)}`).join('\n');
  const root = typeof skillsDir === 'string' && skillsDir ? skillsDir : defaultSkillsDir();
  const extras = Array.isArray(extraSkillDirs) ? extraSkillDirs.filter(value => typeof value === 'string' && value) : [];
  const dirs = [root, ...extras].map(value => `        - ${JSON.stringify(value)}`).join('\n');
  return [
    "# no996-openfilm: who the film conversation's agent is",
    '- id: system-prompt',
    '  config:',
    `    personaPrefix: ${JSON.stringify(persona)}`,
    '# no996-openfilm: a film folder is its own instruction root, so a repository',
    '# above it (this plugin, a monorepo) never injects its manual into a film chat.',
    '- id: agent-instructions',
    '  config:',
    `    maxBytes: ${maxBytes}`,
    '    projectRootMarkers:',
    markers,
    '# no996-openfilm: skill isolation. The sidebar preset whitelists tools but',
    '# keeps the default skill roots (the ~40-entry global catalog). The film child',
    '# only sees this package’s skills/ directory.',
    '- id: skill-filesystem',
    '  config:',
    '    includeDefaultRoots: false',
    '    customSkillDirs:',
    dirs,
    '    watch: false',
    '',
  ].join('\n');
}

/**
 * Write the overlay once per spawn and return its path.
 *
 * @param {object} [options]
 * @param {string} [options.dir] - where to write (default: the OS temp dir)
 * @param {typeof writeFile} [options.write]
 * @param {string} [options.skillsDir] - isolated skill root override (tests)
 * @param {string[]} [options.extraSkillDirs] - per-project additions
 */
export async function writeOverlay({ dir = tmpdir(), write = writeFile, persona, maxBytes, skillsDir, extraSkillDirs } = {}) {
  const file = join(dir, 'dsh-openfilm-acp-instructions.yml');
  await write(file, overlayYaml({ persona, maxBytes, skillsDir, extraSkillDirs }), 'utf8');
  return file;
}

/**
 * The YAML that mounts the preset's prompt module inside the acp child.
 *
 * `openfilm-prompt.mjs` is the same file the sidebar preset mounts as
 * `openfilm-video-prompt` (a `systemPrompt` section). The acp profile has no
 * dependency on this package, so it is loaded by absolute file URL — the same
 * mechanism as the stream tap. `insert` appends the entry; an id-override
 * would fail because the entry does not exist in the acp profile.
 *
 * @param {object} [options]
 * @param {string} [options.href] - file URL override (tests)
 */
export function promptOverlayYaml({ href } = {}) {
  const url = typeof href === 'string' && href ? href : defaultPromptHref();
  return [
    '# no996-openfilm: the preset’s editing guidance, reused verbatim in the film child.',
    '# Same module the sidebar preset mounts as openfilm-video-prompt; single source of truth.',
    '- insert:',
    '    - id: openfilm-video-prompt',
    `      name: ${JSON.stringify(url)}`,
    '',
  ].join('\n');
}

/**
 * Write the prompt overlay once per spawn and return its path.
 *
 * @param {object} [options]
 * @param {string} [options.dir] - where to write (default: the OS temp dir)
 * @param {typeof writeFile} [options.write]
 * @param {string} [options.href] - file URL override (tests)
 */
export async function writePromptOverlay({ dir = tmpdir(), write = writeFile, href } = {}) {
  const file = join(dir, 'dsh-openfilm-acp-prompt.yml');
  await write(file, promptOverlayYaml({ href }), 'utf8');
  return file;
}
