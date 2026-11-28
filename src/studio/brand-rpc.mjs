import { open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readFilmFile } from '../../vendor/film-doc.mjs';
import { brandForScene, prepareBrandPresentation, readProjectBrand, setProjectBrandPlacement, writeProjectBrand } from '../film/project-brand.mjs';
import { applyBrandLogo, hasBrandLogo } from '../film/brand-logo-layer.mjs';

export const BRAND_SETTINGS_CHANNELS = ['brand:settings-get', 'brand:settings-save', 'brand:setup-status', 'brand:setup-dismiss'];
export const BRAND_RPC_CHANNELS = [...BRAND_SETTINGS_CHANNELS, 'brand:project-get', 'brand:project-set', 'brand:project-logo'];
const failure = code => Object.assign(new Error(code), { code });
let bundledLogo;
async function defaultBrandLogo() {
  return bundledLogo ??= await readFile(new URL('../../assets/brand/default-logo.png', import.meta.url), 'base64');
}

async function readSavedFilm(projectPath) {
  const file = join(await realpath(projectPath), 'film.html');
  if ((await realpath(file)) !== file) throw failure('BRAND_FILM_INVALID');
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw failure('BRAND_FILM_INVALID');
    return handle.readFile('utf8');
  } finally { await handle.close(); }
}

export function createBrandRpc({ memory, verifyProject, readFilm = readSavedFilm, http }) {
  async function projectView(projectPath) {
    const snapshot = await readProjectBrand(projectPath);
    const logoPlaced = hasBrandLogo(readFilmFile(await readFilm(projectPath).catch(() => '')).doc);
    return { mode: snapshot?.mode ?? 'off', brand: brandForScene(snapshot), logoPlaced };
  }
  return async (channel, payload) => {
    if (channel === 'brand:setup-status') return { configured: (await memory()).full().configured === true };
    if (channel === 'brand:setup-dismiss') { await (await memory()).dismissSetup(); return { configured: true }; }
    if (channel === 'brand:settings-get') return { settings: (await memory()).full(), defaultLogoBase64: await defaultBrandLogo() };
    if (channel === 'brand:settings-save') {
      const { useDefaultLogo, ...settings } = payload ?? {};
      if (useDefaultLogo === true) settings.logoBase64 = await defaultBrandLogo();
      return { settings: await (await memory()).save(settings) };
    }
    if (!['brand:project-get', 'brand:project-set', 'brand:project-logo'].includes(channel)) throw failure('BRAND_INPUT');
    const project = await verifyProject(payload?.projectId);
    if (channel === 'brand:project-logo') {
      if (!['apply', 'remove'].includes(payload?.action) || Object.keys(payload).some(key => !['projectId', 'action'].includes(key))) throw failure('BRAND_INPUT');
      if (typeof http !== 'function') throw failure('BRAND_LOGO_UNAVAILABLE');
      const snapshot = payload.action === 'apply' ? await readProjectBrand(project.path) : null;
      if (snapshot?.logo) {
        const path = join(await realpath(project.path), snapshot.logo.path);
        if ((await realpath(path)) !== path) throw failure('BRAND_LOGO_MISSING');
      }
      try {
        const presentation = await prepareBrandPresentation(project.path, snapshot);
        return { ...await applyBrandLogo(http(), payload.projectId, presentation, payload.action), logoPlaced: payload.action === 'apply' };
      } catch (error) {
        const expected = ['BRAND_LOGO_NEEDS_PICTURE', 'BRAND_LOGO_LOCKED', 'BRAND_LOGO_MISSING', 'BRAND_LOGO_CONFLICT', 'BRAND_LOGO_REVISION'];
        if (expected.includes(error?.code)) return { errorCode: error.code };
        if (error?.code === 'STUDIO_FAILED') return { errorCode: 'BRAND_LOGO_EDIT_REFUSED' };
        throw error;
      }
    }
    if (channel === 'brand:project-get') {
      const { enabled } = (await memory()).summary();
      return { ...await projectView(project.path), profileEnabled: enabled };
    }
    // Project state is never accepted from a renderer-supplied path or stage size.
    const keys = ['projectId', 'mode', 'placement'];
    if (!payload || Object.keys(payload).some(key => !keys.includes(key))) throw failure('BRAND_INPUT');
    if (payload.mode === 'placement') {
      await setProjectBrandPlacement(project.path, payload.placement);
    } else {
      if (!['snapshot', 'off'].includes(payload.mode)) throw failure('BRAND_INPUT');
      const settings = payload.mode === 'snapshot' ? (await memory()).full() : null;
      if (settings && !settings.enabled) throw failure('BRAND_PROFILE_DISABLED');
      const text = await readFilm(project.path);
      const { doc, problems } = readFilmFile(text);
      if (!doc?.stage || problems.length) throw failure('BRAND_FILM_INVALID');
      const { w, h } = doc.stage;
      const ratio = h > w ? '9:16' : w > h ? '16:9' : '1:1';
      await writeProjectBrand(project.path, { mode: payload.mode, profile: settings, ratio, placement: payload.placement });
    }
    return projectView(project.path);
  };
}
