/**
 * Install the no996 added-provider into OpenFilm's shared home and prefer it for tts.
 *
 * Official loader: `<sharedHome>/providers/<folder>/provider.mjs` (see upstream added.mjs).
 * We copy our stub there on Host start so Studio picks it up without patching BUILT_IN.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);
const STUB = fileURLToPath(new URL('../../vendor/providers/no996/provider.mjs', import.meta.url));

function sharedHomeDir(env = process.env) {
  if (typeof env.OPENFILM_SHARED_HOME === 'string' && env.OPENFILM_SHARED_HOME.trim()) {
    return env.OPENFILM_SHARED_HOME.trim();
  }
  if (typeof env.OPENFILM_HOME === 'string' && env.OPENFILM_HOME.trim()) {
    return env.OPENFILM_HOME.trim();
  }
  return join(homedir(), '.openfilm');
}

function studioHomeDir(env = process.env) {
  if (typeof env.OPENFILM_HOME === 'string' && env.OPENFILM_HOME.trim()) {
    return env.OPENFILM_HOME.trim();
  }
  return join(homedir(), '.openfilm');
}

async function writeAtomic(file, contents, mode = 0o600) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, contents, { encoding: 'utf8', mode });
  await rename(tmp, file);
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, stubPath?: string }} [opts]
 * @returns {Promise<{ sharedHome: string, providerFile: string, written: boolean }>}
 */
export async function installNo996Provider(opts = {}) {
  const env = opts.env || process.env;
  const sharedHome = sharedHomeDir(env);
  const providerFile = join(sharedHome, 'providers', 'no996', 'provider.mjs');
  const stubPath = opts.stubPath || STUB;
  const next = await readFile(stubPath, 'utf8');
  let previous = '';
  try { previous = await readFile(providerFile, 'utf8'); } catch { /* none */ }
  const written = previous !== next;
  if (written) await writeAtomic(providerFile, next, 0o644);
  return { sharedHome, providerFile, written };
}

/**
 * Prefer no996 for media verbs when the person has not pinned another choice, or
 * when `force: true` is explicitly passed. Never steals an explicit third-party pick.
 *
 * @param {{ env?: NodeJS.ProcessEnv, force?: boolean, verbs?: string[] }} [opts]
 */
export async function preferNo996Defaults(opts = {}) {
  const env = opts.env || process.env;
  const force = opts.force === true;
  const verbs = Array.isArray(opts.verbs) && opts.verbs.length ? opts.verbs : ['tts', 'image', 'web-search'];
  const file = join(studioHomeDir(env), 'providers.json');
  let kept = {};
  try {
    kept = JSON.parse(await readFile(file, 'utf8'));
    if (!kept || typeof kept !== 'object' || Array.isArray(kept)) kept = {};
  } catch {
    kept = {};
  }
  const use = kept.use && typeof kept.use === 'object' && !Array.isArray(kept.use) ? { ...kept.use } : {};
  let changed = false;
  for (const verb of verbs) {
    if (force || !use[verb]) {
      if (use[verb] !== 'no996') {
        use[verb] = 'no996';
        changed = true;
      }
    }
  }
  if (!changed) return { file, changed: false, use: { ...use } };
  const next = { ...kept, use };
  await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return { file, changed: true, use: { ...use } };
}

/**
 * Backwards-compatible wrapper for `tts` preference (defaults to non-clobbering unless `force: true`).
 * @param {{ env?: NodeJS.ProcessEnv, force?: boolean }} [opts]
 */
export async function preferNo996ForTts(opts = {}) {
  const res = await preferNo996Defaults({ env: opts.env, force: opts.force === true, verbs: ['tts'] });
  return { file: res.file, changed: res.changed, use: res.use.tts };
}

/** Resolve shared home the same way upstream locations.mjs does (for tests). */
export function resolveSharedHome(env = process.env) {
  return sharedHomeDir(env);
}

/** Optional: confirm openfilm package is present (does not throw). */
export function openfilmPresent() {
  try {
    require.resolve('openfilm/package.json');
    return true;
  } catch {
    return false;
  }
}
