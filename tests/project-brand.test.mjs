import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createBrandRpc } from '../src/studio/brand-rpc.mjs';
import { blankFilmHtml } from '../src/official/official-templates.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { openBrandMemory } from '../src/host/brand-memory.mjs';
import { brandForScene, brandForWriting, parseBrandLogo, prepareBrandPresentation, readProjectBrand, resolveBrandPlacement, setProjectBrandPlacement, writeProjectBrand } from '../src/film/project-brand.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9ioAAAAASUVORK5CYII=';
const rgba = { enabled: true, name: 'Studio A', identity: 'Plain language for first-time viewers', placement: 'top-right', logoBase64: png };

function profile() {
  let record;
  return { async open(spec) {
    // Same unit-name constraint that rejects hyphens on the desktop backend.
    assert.match(spec.name, /^[a-z][a-z0-9_]*$/);
    const { initial, schema } = spec.global;
    record ??= initial;
    return { global: { get: () => record, set: async value => { record = schema.parse(value); } }, close: async () => {} };
  } };
}

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'no996-brand-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('profile settings are off by default and only settings reads retrieve identity and logo bytes', async () => {
  const one = profile();
  const writer = await openBrandMemory(one, z);
  assert.deepEqual(writer.summary(), { enabled: false, name: '', hasLogo: false });
  await writer.save(rgba);
  await writer.save({ ...writer.full(), logoBase64: png, name: 'Studio B' });
  const { logoBase64, ...rest } = writer.full();
  await writer.save({ ...rest, identity: 'A different voice' });
  await writer.close();
  const reopened = await openBrandMemory(one, z);
  const second = await openBrandMemory(profile(), z);
  assert.deepEqual(reopened.summary(), { enabled: true, name: 'Studio B', hasLogo: true });
  assert.equal(reopened.full().logoBase64, logoBase64);
  assert.equal(second.full().logoBase64, null);
  await assert.rejects(async () => reopened.save({ ...rgba, logoBase64: Buffer.from('<svg onload="x"/>').toString('base64') }), { code: 'BRAND_INPUT' });
  assert.equal(reopened.full().name, 'Studio B');
  await reopened.save({ ...reopened.full(), logoBase64: null });
  assert.equal(reopened.summary().hasLogo, false);
});

test('a project keeps its own logo, writing identity and placement when the profile changes', async t => {
  const root = await scratch(t);
  const one = join(root, 'one'), two = join(root, 'two');
  await mkdir(one); await mkdir(two);
  const memory = await openBrandMemory(profile(), z);
  await memory.save(rgba);
  const saved = await writeProjectBrand(one, { mode: 'snapshot', profile: memory.full(), ratio: '9:16', placement: 'bottom-left' });
  assert.equal(saved.placement, 'bottom-left');
  const bytes = await readFile(join(one, saved.logo.path));
  assert.deepEqual(bytes, parseBrandLogo(png).bytes);
  await memory.save({ ...rgba, name: 'Studio B', identity: 'Another writer', logoBase64: null });
  await writeProjectBrand(two, { mode: 'snapshot', profile: memory.full(), ratio: '16:9' });
  assert.deepEqual(await readProjectBrand(one), saved);
  assert.deepEqual(brandForScene(saved), { name: 'Studio A', placement: 'bottom-left', logo: saved.logo.path });
  assert.deepEqual(brandForWriting(saved), { identity: rgba.identity });
  assert.equal((await readProjectBrand(two)).name, 'Studio B');
  assert.equal((await readProjectBrand(two)).logo, null);
  await writeProjectBrand(two, { mode: 'off', ratio: '16:9' });
  assert.equal(brandForScene(await readProjectBrand(two)), null);
  assert.equal(brandForWriting(await readProjectBrand(two)), null);
  assert.equal(memory.full().enabled, true);
});

test('a logo＋name brand becomes one editable local page with a locked or automatic corner', async t => {
  const root = await scratch(t);
  const path = join(root, 'project');
  await mkdir(join(path, 'assets'), { recursive: true });
  await mkdir(join(path, '.film'));
  const memory = await openBrandMemory(profile(), z);
  await memory.save({ ...rgba, display: 'logo-name', placement: 'auto' });
  const saved = await writeProjectBrand(path, { mode: 'snapshot', profile: memory.full(), ratio: '9:16' });
  assert.equal(saved.display, 'logo-name');
  assert.equal(saved.placement, 'top-left');
  assert.equal(saved.placementMode, 'auto');
  const presented = await prepareBrandPresentation(path, saved);
  assert.match(presented.logo.path, /^assets\/brand\/lockup-[a-f0-9]{64}\.html$/);
  assert.deepEqual({ w: presented.logo.width, h: presented.logo.height }, { w: 720, h: 128 });
  const page = await readFile(join(path, presented.logo.path), 'utf8');
  assert.match(page, /data-element-id="brand-mark"[^>]*src="[a-f0-9]{64}\.png"/);
  assert.match(page, /data-element-id="brand-name">Studio A</);
  assert.match(page, /window\.film=/);
  assert.doesNotMatch(page, /<script src|<link|https?:/);
  assert.equal(await prepareBrandPresentation(path, saved).then(value => value.logo.path), presented.logo.path, 'the page is content-addressed');
  await setProjectBrandPlacement(path, 'bottom-right');
  assert.equal((await readProjectBrand(path)).placementMode, 'fixed');
  await assert.rejects(writeProjectBrand(path, { mode: 'snapshot', profile: { ...memory.full(), display: 'sticker' }, ratio: '9:16' }), { code: 'BRAND_INPUT' });
});

test('brand RPC resolves the exact project, trusts the saved canvas and keeps writing identity private', async t => {
  const root = await scratch(t);
  const path = join(root, 'project');
  await mkdir(path);
  await writeFile(join(path, 'film.html'), blankFilmHtml('9:16'));
  const memory = await openBrandMemory(profile(), z);
  const rpc = createBrandRpc({ memory: () => memory, verifyProject(id) {
    if (id !== 'local-project') throw new Error('Project unavailable');
    return { path };
  } });
  await assert.rejects(rpc('brand:project-set', { projectId: 'local-project', mode: 'snapshot' }), { code: 'BRAND_PROFILE_DISABLED' });
  await rpc('brand:settings-save', { ...rgba, placement: 'auto' });
  await assert.rejects(rpc('brand:project-get', { projectId: 'wrong-project' }), /Project unavailable/);
  await assert.rejects(rpc('brand:project-set', { projectId: 'local-project', mode: 'snapshot', ratio: '16:9' }), { code: 'BRAND_INPUT' });
  const applied = await rpc('brand:project-set', { projectId: 'local-project', mode: 'snapshot' });
  assert.equal(applied.brand.placement, 'top-left');
  assert.doesNotMatch(JSON.stringify(applied), /first-time viewers|logoBase64/);
  await rpc('brand:settings-save', { ...rgba, name: 'Changed profile' });
  await rpc('brand:project-set', { projectId: 'local-project', mode: 'placement', placement: 'bottom-left' });
  const view = await rpc('brand:project-get', { projectId: 'local-project' });
  assert.deepEqual(view, { mode: 'snapshot', profileEnabled: true, logoPlaced: false, brand: { ...applied.brand, placement: 'bottom-left' } });
  assert.equal((await rpc('brand:settings-get')).settings.name, 'Changed profile');
});

test('first-run brand settings are opt-in, and the bundled icon can be saved or skipped', async () => {
  const store = profile();
  const memory = await openBrandMemory(store, z);
  const rpc = createBrandRpc({ memory: () => memory });
  const { settings, defaultLogoBase64 } = await rpc('brand:settings-get');
  assert.equal(settings.configured, false);
  assert.equal(settings.enabled, false);
  assert.equal(parseBrandLogo(defaultLogoBase64).width, 256);
  await rpc('brand:settings-save', { ...settings, useDefaultLogo: true, enabled: true, name: 'Demo' });
  assert.equal(memory.full().logoBase64, defaultLogoBase64);
  assert.equal(memory.full().configured, true);
  const skippedStore = profile();
  const skipped = await openBrandMemory(skippedStore, z);
  await skipped.save(settings);
  await skipped.close();
  const reopened = await openBrandMemory(skippedStore, z);
  assert.equal(reopened.full().configured, true);
  assert.equal(reopened.full().enabled, false);
  assert.equal(reopened.full().logoBase64, null);
});

test('auto placement distinguishes portrait and landscape and refuses linked metadata directories', async t => {
  assert.equal(resolveBrandPlacement('9:16'), 'top-left');
  assert.equal(resolveBrandPlacement('16:9'), 'bottom-right');
  assert.equal(resolveBrandPlacement('9:16', 'auto', 'top-right'), 'top-right');
  assert.equal(resolveBrandPlacement('9:16', 'bottom-left', 'top-right'), 'bottom-left');
  const root = await scratch(t);
  await mkdir(join(root, 'project'));
  await mkdir(join(root, 'unrelated'));
  await symlink(join(root, 'unrelated'), join(root, 'project', '.film'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeProjectBrand(join(root, 'project'), { mode: 'snapshot', profile: rgba, ratio: '9:16' }), { code: 'BRAND_INPUT' });
  await assert.rejects(readFile(join(root, 'unrelated', 'brand.json')), { code: 'ENOENT' });
});
