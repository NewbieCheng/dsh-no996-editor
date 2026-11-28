import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const BRAND_PLACEMENTS = ['auto', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
export const BRAND_LOGO_LIMIT = 2 * 1024 * 1024;
export const BRAND_DISPLAYS = ['logo', 'logo-name'];
export const isBrandPresentationClip = clip => clip?.id === 'no996-project-logo' || /^assets\/brand\/lockup-[a-f0-9]{64}\.html(?:[#?]|$)/.test(clip?.src ?? '');
const none = () => ({ enabled: false, name: '', identity: '', placement: 'auto', logo: null });
const missing = error => error?.code === 'ENOENT';
const invalid = () => Object.assign(new Error('BRAND_INPUT'), { code: 'BRAND_INPUT' });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const projectFile = 'brand.json';

export function brandFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const field = (name, max) => {
    const value = input[name] ?? '';
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw invalid();
    return value.trim();
  };
  const placement = input.placement ?? 'auto';
  if (!BRAND_PLACEMENTS.includes(placement) || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw invalid();
  if (input.display !== undefined && !BRAND_DISPLAYS.includes(input.display)) throw invalid();
  return { enabled: input.enabled === true, name: field('name', 80), identity: field('identity', 600), placement,
    ...(input.display === undefined ? {} : { display: input.display }) };
}

// PNG only: a portable transparent logo, with no SVG scripts, remote URLs,
// filenames supplied by the renderer, or MIME type inferred from its claims.
export function parseBrandLogo(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(BRAND_LOGO_LIMIT / 3) * 4) throw invalid();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 45 || bytes.length > BRAND_LOGO_LIMIT || bytes.toString('base64') !== value ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND') throw invalid();
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  if (w < 1 || h < 1 || w > 4096 || h > 4096 || w * h > 8_388_608) throw invalid();
  return { bytes, sha256: digest(bytes), width: w, height: h };
}

export function resolveBrandPlacement(ratio, projectPlacement = 'auto', profilePlacement = 'auto') {
  if (BRAND_PLACEMENTS.includes(projectPlacement) && projectPlacement !== 'auto') return projectPlacement;
  if (BRAND_PLACEMENTS.includes(profilePlacement) && profilePlacement !== 'auto') return profilePlacement;
  return ratio === '9:16' ? 'top-left' : 'bottom-right';
}

async function localDirectory(root, ...segments) {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try { await mkdir(current); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw invalid();
  }
  return current;
}

export async function readProjectBrand(projectPath) {
  const file = join(projectPath, '.film', projectFile);
  try {
    const root = await realpath(projectPath);
    const resolvedFile = await realpath(file);
    if (resolve(root, '.film', projectFile) !== resolve(resolvedFile)) throw invalid();
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 8192) throw invalid();
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (value.version !== 1 || !['off', 'snapshot'].includes(value.mode)) throw invalid();
    const logo = value.logo;
    if (logo !== null && (!logo || !/^[a-f\d]{64}$/.test(logo.sha256 ?? '') || logo.path !== `assets/brand/${logo.sha256}.png` ||
      !Number.isSafeInteger(logo.width) || !Number.isSafeInteger(logo.height) || logo.width < 1 || logo.height < 1 || logo.width > 4096 || logo.height > 4096)) throw invalid();
    return { version: 1, mode: value.mode, ...brandFields(value),
      logo: logo && { path: logo.path, sha256: logo.sha256, width: logo.width, height: logo.height },
      ...(['auto', 'fixed'].includes(value.placementMode) ? { placementMode: value.placementMode } : {}) };
  } catch (error) { if (missing(error)) return null; throw error; }
}

/** Explicit project action only. A snapshot is self-contained and no future
 * profile change can change older films, even if this project is moved. */
export async function writeProjectBrand(projectPath, { mode, profile, placement = 'auto', ratio } = {}) {
  if (!['off', 'snapshot'].includes(mode) || !BRAND_PLACEMENTS.includes(placement) || !['9:16', '16:9', '1:1'].includes(ratio)) throw invalid();
  const root = await realpath(projectPath);
  const metadata = await localDirectory(root, '.film');
  const selected = mode === 'snapshot' ? brandFields(profile) : none();
  let logo = null;
  if (selected.enabled && profile?.logoBase64) {
    const info = parseBrandLogo(profile.logoBase64);
    const directory = await localDirectory(root, 'assets', 'brand');
    const filename = `${info.sha256}.png`;
    const file = join(directory, filename);
    try { await writeFile(file, info.bytes, { flag: 'wx' }); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== info.bytes.length || digest(await readFile(file)) !== info.sha256) throw invalid();
    }
    logo = { path: `assets/brand/${filename}`, sha256: info.sha256, width: info.width, height: info.height };
  }
  const value = { version: 1, mode, ...selected, placement: resolveBrandPlacement(ratio, placement, selected.placement), logo,
    ...(selected.display ? { placementMode: placement === 'auto' && selected.placement === 'auto' ? 'auto' : 'fixed' } : {}) };
  await saveSnapshot(metadata, value);
  return value;
}

/** Create a local, native page clip with independently editable image and name. */
export async function prepareBrandPresentation(projectPath, snapshot) {
  if (!snapshot?.enabled || snapshot.display !== 'logo-name' || !snapshot.name) return snapshot;
  const logo = snapshot.logo;
  const escape = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const image = logo ? `<img data-element-id="brand-mark" src="${logo.sha256}.png" alt="" width="${Math.max(1, Math.round(logo.width * Math.min(300 / logo.width, 96 / logo.height)))}" height="${Math.max(1, Math.round(logo.height * Math.min(300 / logo.width, 96 / logo.height)))}">` : '';
  const width = 720, height = 128;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}body{display:flex;align-items:center;justify-content:${snapshot.placement.endsWith('right') ? 'flex-end' : 'flex-start'};gap:22px;color:white;font:600 38px/1.14 system-ui,sans-serif;text-shadow:0 2px 4px #000,0 0 10px #000}img{display:block;flex:none;object-fit:contain}span{min-width:0;overflow-wrap:anywhere;padding-right:8px}</style></head><body>${image}<span data-element-id="brand-name">${escape(snapshot.name)}</span><script>window.film={width:${width},height:${height},duration:3,ready:Promise.all(Array.from(document.images,image=>image.decode())),frame(){}};</script></body></html>`;
  const bytes = Buffer.from(html);
  const filename = `lockup-${digest(bytes)}.html`;
  const directory = await localDirectory(await realpath(projectPath), 'assets', 'brand');
  const target = join(directory, filename);
  try { await writeFile(target, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const entry = await lstat(target);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== bytes.length || !(await readFile(target)).equals(bytes)) throw invalid();
  }
  return { ...snapshot, logo: { path: `assets/brand/${filename}`, width, height } };
}

export async function setProjectBrandPlacement(projectPath, placement) {
  if (!BRAND_PLACEMENTS.includes(placement) || placement === 'auto') throw invalid();
  const saved = await readProjectBrand(projectPath);
  if (saved?.mode !== 'snapshot' || !saved.enabled) throw invalid();
  const directory = await localDirectory(await realpath(projectPath), '.film');
  const value = { ...saved, placement, ...(saved.display ? { placementMode: 'fixed' } : {}) };
  await saveSnapshot(directory, value);
  return value;
}

async function saveSnapshot(directory, value) {
  const file = join(directory, projectFile);
  const tmp = join(dirname(file), `brand-${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(tmp, file);
  } finally { await rm(tmp, { force: true }).catch(() => {}); }
  return value;
}

/** Scene consumers get placement, a text label and a relative asset—not identity. */
export function brandForScene(snapshot) {
  return snapshot?.mode === 'snapshot' && snapshot.enabled
    ? { name: snapshot.name, placement: snapshot.placement, logo: snapshot.logo?.path ?? null,
      ...(snapshot.display ? { display: snapshot.display, placementMode: snapshot.placementMode ?? 'fixed' } : {}) }
    : null;
}

/** Only an explicit writing workflow should call this. No image or paths. */
export function brandForWriting(snapshot) {
  return snapshot?.mode === 'snapshot' && snapshot.enabled && snapshot.identity ? { identity: snapshot.identity } : null;
}
