// What instruction files a film conversation actually gets, for `/diagnose`.
//
// "The agent talked about the repository" was undebuggable: the injected files are
// chosen inside DSH, from a chain nobody could see from here. This module reproduces
// that chain's *decision* (not its rendering) so the panel can show which files and
// how many bytes, and so a regression — a manual leaking back in — is visible in one
// place instead of inferred from a strange answer.
//
// The rules mirrored from `@deepseek-ai/dsh-agent-instructions`:
//   · the user-global chain: `$DSH_HOME/AGENTS.md`, then `~/.agents/AGENTS.md`;
//   · the project chain: from the project root down to the session's working
//     directory, one `AGENTS.md`/`CLAUDE.md` per level;
//   · the project root is the nearest ancestor carrying a root marker (`.git` here,
//     plus `.film`/`film.html` once the child's overlay applies).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ROOT_MARKERS } from './agent-overlays.mjs';

const CANDIDATES = ['AGENTS.md', 'CLAUDE.md'];

/** The nearest ancestor of `from` that holds one of `markers` (itself included). */
export function projectRootOf(from, markers = ROOT_MARKERS, fs = { existsSync, statSync }) {
  let current = resolve(from);
  for (;;) {
    for (const marker of markers) {
      try {
        if (fs.existsSync(join(current, marker))) return current;
      } catch { /* unreadable directory: keep walking up */ }
    }
    const parent = dirname(current);
    if (parent === current || !parent.startsWith(current.split(sep)[0] ?? '')) return undefined;
    current = parent;
  }
}

/** The files one directory level would contribute, with their sizes. */
function filesAt(directory, fs) {
  const kept = [];
  for (const name of CANDIDATES) {
    const file = join(directory, name);
    try {
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      if (Number.isFinite(size)) kept.push({ file, bytes: size });
    } catch { /* a file that cannot be read is not loaded either */ }
  }
  return kept;
}

/**
 * The chain the child will read, broad to specific.
 *
 * @param {object} options
 * @param {string} options.cwd - the session's working directory (the film folder)
 * @param {string} [options.dshHome] - `$DSH_HOME` (default `~/.dsh` is the caller's business)
 * @param {string} [options.agentsHome] - the shared `~/.agents` directory
 * @param {string[]} [options.markers] - root markers in force
 * @param {object} [options.fs] - injectable file system (tests)
 * @returns {{files: Array<{file: string, bytes: number, level: string}>, root: string|undefined, outside: string[]}}
 */
export function instructionChain({ cwd, dshHome, agentsHome, markers = ROOT_MARKERS, fs = { existsSync, statSync } } = {}) {
  if (typeof cwd !== 'string' || !cwd) return { files: [], root: undefined, outside: [] };
  const files = [];
  const add = (directory, level) => { for (const entry of filesAt(directory, fs)) files.push({ ...entry, level }); };
  if (typeof dshHome === 'string' && dshHome) add(dshHome, 'user-global');
  if (typeof agentsHome === 'string' && agentsHome) add(agentsHome, 'shared-agents');
  const root = projectRootOf(cwd, markers, fs);
  const start = root ?? cwd;
  // Broad to specific: root first, then each child directory down to the cwd.
  const parts = [];
  let current = resolve(cwd);
  const stop = resolve(start);
  for (;;) {
    parts.unshift(current);
    if (current === stop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const directory of parts) add(directory, directory === stop ? 'project-root' : 'project');
  // Anything above the film folder that the chain would have read without the
  // markers: the exact leak this change removes, reported so it cannot come back.
  const outside = [];
  if (root) {
    let above = dirname(root);
    while (above && above !== dirname(above)) {
      for (const entry of filesAt(above, fs)) outside.push(entry.file);
      above = dirname(above);
    }
  }
  return { files, root, outside };
}

/** Read a file's first line for the report; never throws. */
export function headOf(file, fs = { readFileSync }) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return String(text).split('\n').find(line => line.trim())?.trim().slice(0, 120) ?? '';
  } catch { return ''; }
}
