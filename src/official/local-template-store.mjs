import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { normalizeRecipe, RECIPE_ASSET_BYTES, RECIPE_FILE } from '../film/template-recipe.mjs';

const ID = /^[a-z][a-z0-9-]{2,63}$/;
const bad = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)); };

/** Project-independent local recipe library. It stores only recipe.json and
 * allowlisted asset files, never a film folder, chat, cache or render output. */
export function createLocalTemplateStore({ root }) {
  if (typeof root !== 'string' || !resolve(root)) throw new TypeError('A local template root is required');
  async function directory() {
    await mkdir(root, { recursive: true });
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw bad('LOCAL_TEMPLATE_ROOT');
    return realpath(root);
  }
  async function readRecipe(base, id) {
    if (!ID.test(id)) throw bad('LOCAL_TEMPLATE_INPUT');
    const file = join(base, id, RECIPE_FILE);
    if (resolve(await realpath(file)) !== resolve(file)) throw bad('LOCAL_TEMPLATE_INPUT');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw bad('LOCAL_TEMPLATE_INPUT');
    const recipe = normalizeRecipe(JSON.parse(await readFile(file, 'utf8')));
    if (recipe.id !== id) throw bad('LOCAL_TEMPLATE_INPUT');
    return recipe;
  }
  async function readBytes(base, recipe) {
    const bytes = new Map();
    for (const asset of recipe.assets) {
      const file = join(base, recipe.id, asset.path);
      if (!inside(join(base, recipe.id), resolve(file)) || resolve(await realpath(file)) !== resolve(file)) throw bad('LOCAL_TEMPLATE_INPUT');
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.bytes || info.size > 32 * 1024 * 1024) throw bad('LOCAL_TEMPLATE_ASSET');
      const body = await readFile(file);
      if (hash(body) !== asset.sha256) throw bad('LOCAL_TEMPLATE_ASSET');
      bytes.set(asset.path, body);
    }
    return bytes;
  }
  return {
    root,
    async list() {
      const base = await directory();
      const items = [];
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !ID.test(entry.name)) continue;
        try {
          const recipe = await readRecipe(base, entry.name);
          items.push({ id: recipe.id, title: recipe.title, description: recipe.description, canvas: recipe.canvas,
            scenes: recipe.scenes.length, assets: recipe.assets.length, hasBgm: Boolean(recipe.bgm), hasBrand: Boolean(recipe.brand), source: 'local' });
        } catch { /* One damaged recipe must not hide the rest of the library. */ }
      }
      return items.sort((a, b) => a.title.localeCompare(b.title));
    },
    async get(id) {
      const base = await directory(), recipe = await readRecipe(base, id);
      Object.defineProperty(recipe, RECIPE_ASSET_BYTES, { value: await readBytes(base, recipe) });
      return recipe;
    },
    async save(recipe) {
      const safe = normalizeRecipe(recipe), bytes = recipe[RECIPE_ASSET_BYTES];
      if (!(bytes instanceof Map) || bytes.size !== safe.assets.length) throw bad('LOCAL_TEMPLATE_ASSET');
      const base = await directory(), target = join(base, safe.id), temporary = join(base, `.tmp-${process.pid}-${Date.now()}`);
      await mkdir(temporary);
      try {
        await writeFile(join(temporary, RECIPE_FILE), `${JSON.stringify(safe, null, 2)}\n`, { flag: 'wx' });
        for (const asset of safe.assets) {
          const body = bytes.get(asset.path);
          if (!Buffer.isBuffer(body) || body.length !== asset.bytes || hash(body) !== asset.sha256) throw bad('LOCAL_TEMPLATE_ASSET');
          const file = join(temporary, asset.path);
          await mkdir(dirname(file), { recursive: true });
          const handle = await open(file, 'wx');
          try { await handle.writeFile(body); } finally { await handle.close(); }
        }
        try {
          await readRecipe(base, safe.id);
          await rm(temporary, { recursive: true, force: true });
          return { id: safe.id };
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        await rename(temporary, target);
      } catch (error) { await rm(temporary, { recursive: true, force: true }).catch(() => {}); throw error; }
      return { id: safe.id };
    },
    async remove(id) {
      const base = await directory();
      await readRecipe(base, id);
      await rm(join(base, id), { recursive: true, force: true });
      return { id };
    },
  };
}
