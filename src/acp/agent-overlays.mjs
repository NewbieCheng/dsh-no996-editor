// The child's identity and its instruction boundary, delivered as `--patch` overlays.
//
// Two things were wrong with the panel's agent before this file existed:
//
//   1. Its identity came from the acp profile: "You are a coding agent". A film
//      conversation answered like a developer tool, because it was told it was one.
//   2. Its instructions came from wherever DSH found `AGENTS.md`, and DSH marks the
//      project root by `.git`. A film library living inside this plugin's repository
//      therefore injected *this repository's* developer manual into every film chat:
//      the agent recited "0.15.x / MIT / four UI layers" at someone asking for a cut.
//
// Both are fixed here, in the child's own configuration, instead of asking the model
// to ignore what it was told:
//
//   · `system-prompt.personaPrefix` says who it is;
//   · `agent-instructions.projectRootMarkers` adds the markers every OpenFilm project
//     folder already has (`.film`, `film.html`), so the instruction chain starts at
//     the film folder and never reaches a repository above it.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** What the panel's agent is. Short on purpose: identity, not a manual. */
export const PERSONA = [
  '你是 No996 Studio 的剪辑导演，用中文和用户说话。',
  '你交付的是能播的片子，不是代码：先说清楚这支片要干什么，再决定镜头、动效和节奏，最后才动 film.html。',
  '工具怎么用读 openfilm_guide；做片前先读 openfilm-motion 技能；用户丢视频过来时先转写口播再剪。',
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
 * The YAML of the overlay. `insert` is not used: both entries already exist in the
 * acp profile, so these are id-targeted overrides.
 *
 * @param {object} [options]
 * @param {string} [options.persona] - override for tests
 * @param {number} [options.maxBytes] - instruction budget, kept explicit
 */
export function overlayYaml({ persona = PERSONA, maxBytes = 65536 } = {}) {
  const markers = ROOT_MARKERS.map(marker => `        - ${JSON.stringify(marker)}`).join('\n');
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
    '',
  ].join('\n');
}

/**
 * Write the overlay once per spawn and return its path.
 *
 * @param {object} [options]
 * @param {string} [options.dir] - where to write (default: the OS temp dir)
 * @param {typeof writeFile} [options.write]
 */
export async function writeOverlay({ dir = tmpdir(), write = writeFile, persona, maxBytes } = {}) {
  const file = join(dir, 'dsh-openfilm-acp-instructions.yml');
  await write(file, overlayYaml({ persona, maxBytes }), 'utf8');
  return file;
}
