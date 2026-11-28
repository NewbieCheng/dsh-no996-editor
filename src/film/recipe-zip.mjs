import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { normalizeRecipe, RECIPE_FILE, RECIPE_ASSET_BYTES } from './template-recipe.mjs';

const MAX_ZIP = 64 * 1024 * 1024;
const MAX_FILES = 256;
const bad = code => Object.assign(new Error(code), { code });
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const safeName = name => typeof name === 'string' && name.length < 300 && (name === RECIPE_FILE || /^assets\/[a-f0-9]{64}\.(?:png|jpg|webp|gif|mp3|wav|flac|ogg)$/.test(name));

/** Deterministic ZIP64-free writer, DEFLATE with CRC and UTF-8 names. */
export function writeRecipeZip(recipe, bytes = recipe[RECIPE_ASSET_BYTES] ?? new Map()) {
  const safe = normalizeRecipe(recipe);
  const entries = [{ name: RECIPE_FILE, bytes: Buffer.from(`${JSON.stringify(safe, null, 2)}\n`) }];
  for (const asset of safe.assets) {
    const body = bytes.get(asset.path);
    if (!Buffer.isBuffer(body) || body.length !== asset.bytes || createHash('sha256').update(body).digest('hex') !== asset.sha256) throw bad('RECIPE_ASSET');
    entries.push({ name: asset.path, bytes: body });
  }
  if (entries.length > MAX_FILES || entries.reduce((sum, entry) => sum + entry.bytes.length, 0) > MAX_ZIP) throw bad('RECIPE_TOO_LARGE');
  const locals = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), compressed = deflateRawSync(entry.bytes), crc = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0x21, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8);
    dir.writeUInt16LE(8, 10); dir.writeUInt16LE(0x21, 12); dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(compressed.length, 20); dir.writeUInt32LE(entry.bytes.length, 24);
    dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Accept stored/deflated regular files only; never extract paths to disk. */
export function readRecipeZip(zip) {
  if (!Buffer.isBuffer(zip) || zip.length < 22 || zip.length > MAX_ZIP) throw bad('RECIPE_ZIP_INPUT');
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0 || eocd + 22 > zip.length) throw bad('RECIPE_ZIP_INPUT');
  const count = zip.readUInt16LE(eocd + 10), size = zip.readUInt32LE(eocd + 12), start = zip.readUInt32LE(eocd + 16);
  if (!count || count > MAX_FILES || start + size !== eocd) throw bad('RECIPE_ZIP_INPUT');
  const entries = new Map();
  let cursor = start, total = 0;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > eocd || zip.readUInt32LE(cursor) !== 0x02014b50) throw bad('RECIPE_ZIP_INPUT');
    const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10), crc = zip.readUInt32LE(cursor + 16);
    const compressed = zip.readUInt32LE(cursor + 20), original = zip.readUInt32LE(cursor + 24), nameLen = zip.readUInt16LE(cursor + 28);
    const extraLen = zip.readUInt16LE(cursor + 30), commentLen = zip.readUInt16LE(cursor + 32), local = zip.readUInt32LE(cursor + 42);
    if (flags & 1 || ![0, 8].includes(method) || original > MAX_ZIP || compressed > MAX_ZIP || cursor + 46 + nameLen + extraLen + commentLen > eocd) throw bad('RECIPE_ZIP_INPUT');
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    if (!safeName(name) || entries.has(name) || local + 30 > start || zip.readUInt32LE(local) !== 0x04034b50) throw bad('RECIPE_ZIP_INPUT');
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (dataAt + compressed > start) throw bad('RECIPE_ZIP_INPUT');
    const packed = zip.subarray(dataAt, dataAt + compressed);
    const bytes = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: MAX_ZIP });
    if (bytes.length !== original || crc32(bytes) !== crc) throw bad('RECIPE_ZIP_INPUT');
    total += bytes.length;
    if (total > MAX_ZIP) throw bad('RECIPE_TOO_LARGE');
    entries.set(name, bytes);
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  if (cursor !== eocd || !entries.has(RECIPE_FILE)) throw bad('RECIPE_ZIP_INPUT');
  let parsed;
  try { parsed = JSON.parse(entries.get(RECIPE_FILE).toString('utf8')); } catch { throw bad('RECIPE_ZIP_INPUT'); }
  const recipe = normalizeRecipe(parsed), bytes = new Map();
  if (entries.size !== recipe.assets.length + 1) throw bad('RECIPE_ZIP_INPUT');
  for (const asset of recipe.assets) {
    const body = entries.get(asset.path);
    if (!body || body.length !== asset.bytes || createHash('sha256').update(body).digest('hex') !== asset.sha256) throw bad('RECIPE_ASSET');
    bytes.set(asset.path, body);
  }
  Object.defineProperty(recipe, RECIPE_ASSET_BYTES, { value: bytes });
  return recipe;
}
