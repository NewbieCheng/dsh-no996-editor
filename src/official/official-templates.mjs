import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { filmHtml } from '../../vendor/film-doc.mjs';
import { installedTemplatePath, readBundledTemplateLayouts, selectBundledTemplateLayout } from '../film/template-layouts.mjs';

const BLANK_STAGES = new Map([['16:9', [1920, 1080]], ['9:16', [1080, 1920]], ['1:1', [1080, 1080]]]);

export function blankFilmHtml(ratio = '16:9') {
  const size = BLANK_STAGES.get(ratio);
  if (!size) throw failure('TEMPLATE_INPUT', 'Invalid canvas ratio');
  const [w, h] = size;
  return filmHtml({ stage: { w, h }, tracks: [] });
}

export async function createBlankOfficialProject({ ratio, parentDir, createProject, setStage = () => {} }) {
  const film = blankFilmHtml(ratio);
  setStage('prepare-directory');
  await mkdir(parentDir, { recursive: true });
  const target = await mkdtemp(join(parentDir, '自定义-'));
  setStage('write-blank');
  await writeFile(join(target, 'film.html'), film, { flag: 'wx' });
  setStage('register');
  const project = await createProject(target);
  if (!project || typeof project.id !== 'string' || typeof project.path !== 'string') throw new Error('Studio returned an invalid project');
  return { projectId: project.id, path: project.path };
}

// Keep discovery, installation and the template-prompt catalog on the same ID contract.
const TEMPLATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_FILES = 4_000;
const MAX_BYTES = 64 * 1024 * 1024;
const failure = (code, message) => Object.assign(new Error(message), { code });

/** List metadata for the templates shipped with the plugin. */
export async function listTemplates(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw failure('TEMPLATE_ROOT', 'A template root is required');
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const templates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !TEMPLATE_ID.test(entry.name)) continue;
    let manifest, layouts;
    try {
      manifest = JSON.parse(await readFile(join(root, entry.name, 'manifest.json'), 'utf8'));
      layouts = readBundledTemplateLayouts(manifest);
    } catch { continue; }
    if (!manifest || typeof manifest !== 'object' || manifest.id !== entry.name) continue;
    if (typeof manifest.title !== 'string' || typeof manifest.entry !== 'string' || typeof manifest.mode !== 'string') continue;
    templates.push({
      id: entry.name,
      title: manifest.title.slice(0, 60),
      description: typeof manifest.description === 'string' ? manifest.description.slice(0, 240) : '',
      mode: manifest.mode === 'film' ? 'film' : 'style',
      entry: manifest.entry,
      prompt: typeof manifest.prompt === 'string' ? manifest.prompt.slice(0, 600) : '',
      order: typeof manifest.order === 'number' && Number.isFinite(manifest.order) ? manifest.order : 100,
      featured: manifest.featured === true,
      ...(layouts ? { ratios: layouts.ratios, defaultRatio: layouts.defaultRatio } : {}),
    });
  }
  return templates.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Finish bookkeeping after Studio has already registered a new project.
 * A bookkeeping failure must not disguise the created project as a failed copy.
 */
export async function finishTemplateCreation(created, { activate, remember }) {
  const warnings = [];
  try { await activate(); } catch { warnings.push('TEMPLATE_ACTIVATION_FAILED'); }
  let result = created;
  try { result = await remember() ?? created; } catch { warnings.push('PREFERENCES_SAVE_FAILED'); }
  return { ...result, ...created, ...(warnings.length ? { warnings } : {}) };
}

const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Copy all regular files, including manifests, into an exclusively created folder.
 * No cleanup is attempted: once registration starts even a rejection can mean
 * that Studio committed the project. Errors identify the potentially remaining folder.
 */
export async function installTemplate({ root, id, ratio, parentDir, createProject, titleFor, setStage = () => {} }) {
  if (typeof root !== 'string' || !isAbsolute(root) || typeof parentDir !== 'string' || !isAbsolute(parentDir) ||
      typeof id !== 'string' || !TEMPLATE_ID.test(id) || typeof createProject !== 'function' || typeof titleFor !== 'function') {
    throw failure('TEMPLATE_INPUT', 'Invalid template installation arguments');
  }
  setStage('template-preflight');
  const source = join(resolve(root), id);
  const sourceInfo = await lstat(source).catch(() => null);
  if (!sourceInfo?.isDirectory() || sourceInfo.isSymbolicLink()) throw failure('TEMPLATE_INPUT', 'Template is missing or is a link');
  const realSource = await realpath(source);
  // Reject a symlinked template root as well as a symlinked template itself.
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw failure('TEMPLATE_INPUT', 'Invalid template root');
  const manifestPath = join(realSource, 'manifest.json');
  const manifestInfo = await lstat(manifestPath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  let manifest;
  if (manifestInfo?.isFile() && manifestInfo.size <= 32_768) {
    const handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try { manifest = JSON.parse(await handle.readFile('utf8')); }
    catch { /* a legacy template may not have versioned metadata */ }
    finally { await handle.close(); }
  }
  const layout = selectBundledTemplateLayout(readBundledTemplateLayouts(manifest), ratio);
  if (layout) {
    const entry = await lstat(join(realSource, layout.entry)).catch(() => null);
    const pages = await lstat(join(realSource, layout.pages)).catch(() => null);
    if (!entry?.isFile() || !pages?.isDirectory() || entry.isSymbolicLink() || pages.isSymbolicLink()) {
      throw failure('TEMPLATE_INPUT', 'The selected layout is not built');
    }
  }
  // Resolve the nearest existing ancestor before mkdir, so even a new parent
  // under a symlink alias of the template cannot modify the source tree.
  setStage('prepare-directory');
  let ancestor = resolve(parentDir);
  const missing = [];
  for (;;) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = dirname(ancestor);
      if (next === ancestor) throw error;
      missing.unshift(relative(next, ancestor));
      ancestor = next;
    }
  }
  const prospectiveParent = resolve(await realpath(ancestor), ...missing);
  if (inside(realSource, prospectiveParent)) throw failure('TEMPLATE_INPUT', 'Project parent is inside the template');
  await mkdir(parentDir, { recursive: true });
  const parentInfo = await lstat(parentDir);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw failure('TEMPLATE_INPUT', 'Invalid project parent directory');
  const realParent = await realpath(parentDir);
  if (inside(realSource, realParent)) throw failure('TEMPLATE_INPUT', 'Project parent is inside the template');

  let count = 0;
  let total = 0;
  // Preflight rejects unsafe entries and oversized templates before creating a target.
  const scan = async dir => {
    for (const name of await readdir(dir)) {
      if (name === '.' || name === '..' || /[\\/:]/u.test(name)) throw failure('TEMPLATE_INPUT', 'Unsafe template path');
      if (dir === realSource && installedTemplatePath(name, layout) === null) continue;
      const item = join(dir, name);
      const info = await lstat(item);
      if (info.isSymbolicLink()) throw failure('TEMPLATE_INPUT', 'Template contains a symbolic link');
      if (info.isDirectory()) await scan(item);
      else if (info.isFile()) {
        count++;
        total += info.size;
        if (count > MAX_FILES || total > MAX_BYTES) throw failure('TEMPLATE_TOO_LARGE', 'Template exceeds the install limit');
      } else throw failure('TEMPLATE_INPUT', 'Template contains a special file');
    }
  };
  setStage('template-preflight');
  await scan(realSource);

  setStage('prepare-directory');
  const slug = String(titleFor(id) || id).replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || id;
  let target;
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = join(realParent, `${slug}-${randomBytes(6).toString('hex')}`);
    try { await mkdir(candidate); target = candidate; break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (!target) throw failure('TEMPLATE_TARGET', 'Could not allocate a unique project directory');

  let files = 0;
  let bytes = 0;
  let registering = false;
  try {
    const copy = async (src, dst) => {
      for (const name of await readdir(src)) {
        if (name === '.' || name === '..' || /[\\/:]/u.test(name)) throw failure('TEMPLATE_INPUT', 'Unsafe template path');
        const installedName = src === realSource ? installedTemplatePath(name, layout) : name;
        if (installedName === null) continue;
        const from = join(src, name);
        const to = join(dst, installedName);
        const info = await lstat(from);
        if (info.isSymbolicLink()) throw failure('TEMPLATE_INPUT', 'Template contains a symbolic link');
        if (info.isDirectory()) {
          await mkdir(to);
          await copy(from, to);
        } else if (info.isFile()) {
          if (++files > MAX_FILES) throw failure('TEMPLATE_TOO_LARGE', 'Template exceeds the install limit');
          const input = await open(from, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
          try {
            const opened = await input.stat();
            if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw failure('TEMPLATE_INPUT', 'Template changed during installation');
            const output = await open(to, 'wx');
            try {
              const buffer = Buffer.allocUnsafe(64 * 1024);
              for (;;) {
                const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                bytes += bytesRead;
                if (bytes > MAX_BYTES) throw failure('TEMPLATE_TOO_LARGE', 'Template exceeds the install limit');
                let written = 0;
                while (written < bytesRead) {
                  const result = await output.write(buffer, written, bytesRead - written);
                  if (!result.bytesWritten) throw new Error('Unable to write template file');
                  written += result.bytesWritten;
                }
              }
            } finally { await output.close(); }
          } finally { await input.close(); }
        } else throw failure('TEMPLATE_INPUT', 'Template contains a special file');
      }
    };
    setStage('copy');
    await copy(realSource, target);
    registering = true;
    setStage('register');
    const project = await createProject(target);
    if (!project || typeof project.id !== 'string' || typeof project.path !== 'string') throw new Error('Studio returned an invalid project');
    return { projectId: project.id, path: project.path, files, bytes, ...(layout ? { ratio: layout.ratio } : {}) };
  } catch (cause) {
    const error = failure(registering ? 'TEMPLATE_REGISTRATION_UNCERTAIN' : (cause?.code || 'TEMPLATE_COPY_FAILED'),
      `${registering ? 'Project registration failed or its result is uncertain' : 'Template copy failed'}; the project directory may remain at ${target}. No files were deleted.`);
    Object.assign(error, { cause, targetPath: target, residual: true, registrationUnknown: registering });
    throw error;
  }
}
