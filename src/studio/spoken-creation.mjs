import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { prepareSpokenBgm } from '../audio/spoken-bgm.mjs';
import { planSpokenCopy, splitSpokenCopy } from '../film/spoken-blueprint.mjs';
import { spokenProjectFiles } from '../film/spoken-project.mjs';

// Keep this below the existing 9 MiB JSON transport cap after base64 expansion.
export const SPOKEN_UPLOAD_LIMIT = 6 * 1024 * 1024;
const SESSION_WINDOW_MS = 15 * 60_000;
const bad = code => Object.assign(new Error(code), { code });
const recoverable = new Set(['SPOKEN_MODEL_FAILED', 'SPOKEN_BLUEPRINT_INPUT', 'SPOKEN_BGM_UNAVAILABLE', 'SPOKEN_BGM_INPUT',
  'SPOKEN_BGM_DECODE_FAILED', 'SPOKEN_CREATION_BUSY', 'SPOKEN_CREATION_FAILED']);

// The form owns expected failures. Unknown failures still go to shell diagnostics.
export async function spokenCreationResult(create, payload, proxy) {
  try { return await create(payload, proxy); }
  catch (error) {
    if (recoverable.has(error?.code)) return { errorCode: error.code };
    throw error;
  }
}

/** template:create-spoken v1; accepts no filesystem paths, target project IDs, or model routes. */
function parse(input) {
  const keys = ['requestId', 'ratio', 'copy', 'music', 'audioBase64'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)) ||
    typeof input.requestId !== 'string' || !/^[a-f\d-]{36}$/i.test(input.requestId) ||
    !['9:16', '16:9'].includes(input.ratio) || !['default', 'upload', 'none'].includes(input.music)) throw bad('SPOKEN_BLUEPRINT_INPUT');
  splitSpokenCopy(input.copy);
  let upload;
  if (input.music === 'upload') {
    if (typeof input.audioBase64 !== 'string' || !input.audioBase64 || input.audioBase64.length > Math.ceil(SPOKEN_UPLOAD_LIMIT / 3) * 4) throw bad('SPOKEN_BGM_INPUT');
    upload = Buffer.from(input.audioBase64, 'base64');
    if (upload.length > SPOKEN_UPLOAD_LIMIT || upload.toString('base64') !== input.audioBase64) throw bad('SPOKEN_BGM_INPUT');
  } else if (input.audioBase64 !== undefined) throw bad('SPOKEN_BGM_INPUT');
  const signature = createHash('sha256').update(JSON.stringify([input.ratio, input.music, input.copy])).update(upload ?? '').digest('hex');
  return { requestId: input.requestId, signature, ratio: input.ratio, music: input.music, copy: input.copy, upload };
}

/** One authenticated explicit submission prepares, writes and registers a new project.
 * Coalesces retries for this Host lifetime; an uncertain registration is never retried. */
export function createSpokenCreation({ ask, projectParent, remember, resolveBgm = prepareSpokenBgm, clock = Date.now, deadline = () => AbortSignal.timeout(120_000) }) {
  const recent = new Map();
  async function create(input, proxy) {
    if (!proxy || typeof proxy.createProject !== 'function') throw bad('SPOKEN_CREATION_UNAVAILABLE');
    const signal = deadline();
    const bgm = await resolveBgm({ mode: input.music, upload: input.upload, signal });
    let blueprint;
    try { blueprint = await planSpokenCopy({ ask, copy: input.copy, ratio: input.ratio, music: input.music, signal }); }
    catch (error) {
      if (error?.code === 'SPOKEN_BLUEPRINT_INPUT') throw error;
      throw bad('SPOKEN_MODEL_FAILED');
    }
    signal.throwIfAborted();
    let target;
    try {
      const files = spokenProjectFiles(blueprint, { bgm });
      const parent = await projectParent(proxy);
      signal.throwIfAborted();
      await mkdir(parent, { recursive: true });
      target = await mkdtemp(join(parent, 'Vibe-'));
      for (const [relative, body] of files) {
        const file = join(target, relative);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body, { flag: 'wx', signal });
      }
      signal.throwIfAborted();
    } catch {
      if (target) await rm(target, { recursive: true, force: true }).catch(() => {});
      throw bad('SPOKEN_CREATION_FAILED');
    }
    let project;
    try { project = await proxy.createProject(target); }
    catch { throw bad('TEMPLATE_REGISTRATION_UNCERTAIN'); }
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(project?.id ?? '') || typeof project.path !== 'string') throw bad('TEMPLATE_REGISTRATION_UNCERTAIN');
    let warnings;
    try { warnings = await remember?.(project, input.ratio); }
    catch { warnings = ['SPOKEN_BOOKKEEPING_FAILED']; }
    return { projectId: project.id, ratio: input.ratio, durationMs: blueprint.durationMs, timing: blueprint.timing, ...(warnings?.length ? { warnings } : {}) };
  }

  return async (body, proxy) => {
    const input = parse(body);
    for (const [key, value] of recent) if (value.until <= clock()) recent.delete(key);
    const existing = recent.get(input.requestId);
    if (existing) {
      if (existing.signature !== input.signature) throw bad('SPOKEN_REQUEST_CONFLICT');
      return existing.operation;
    }
    if (recent.size >= 64 || [...recent.values()].filter(value => value.until === Infinity).length >= 2) throw bad('SPOKEN_CREATION_BUSY');
    const entry = { signature: input.signature, until: Infinity };
    entry.operation = create(input, proxy).then(result => {
      entry.until = clock() + SESSION_WINDOW_MS;
      return result;
    }, error => {
      if (error?.code === 'TEMPLATE_REGISTRATION_UNCERTAIN') entry.until = clock() + SESSION_WINDOW_MS;
      else recent.delete(input.requestId);
      throw error;
    });
    recent.set(input.requestId, entry);
    return entry.operation;
  };
}
