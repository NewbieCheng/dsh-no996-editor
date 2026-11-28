import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlankOfficialProject, finishTemplateCreation, installTemplate, listTemplates } from '../src/official/official-templates.mjs';
import { searchTemplates, templateCatalog } from '../src/film/template-catalog.mjs';
import { selectBundledTemplateLayout } from '../src/film/template-layouts.mjs';
import { shotWall } from '../vendor/templates/_kit/render.mjs';
import { readFilmFile } from 'openfilm/film-doc';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'openfilm-template-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'templates');
  const source = join(root, 'sample');
  const parentDir = join(base, 'projects');
  await mkdir(source, { recursive: true });
  await mkdir(parentDir);
  const args = { root, parentDir, id: 'sample', titleFor: () => '中文 film', createProject: async path => ({ id: 'project', path }) };
  return { base, root, source, parentDir, args };
}

test('blank creation writes a fresh saved film before registering once', async t => {
  const { base } = await fixture(t);
  const parentDir = join(base, 'new-library');
  const stages = [];
  const created = await createBlankOfficialProject({ ratio: '9:16', parentDir, setStage: stage => stages.push(stage), async createProject(path) {
    const film = readFilmFile(await readFile(join(path, 'film.html'), 'utf8'));
    assert.deepEqual(film.doc.stage, { w: 1080, h: 1920 });
    return { id: 'new-project', path };
  } });
  assert.equal(created.projectId, 'new-project');
  assert.deepEqual(stages, ['prepare-directory', 'write-blank', 'register']);
  assert.equal((await readdir(parentDir)).length, 1);
});

test('bookkeeping failures retain the registered project and report fixed warnings', async () => {
  const created = { projectId: 'project1', path: '/safe/new-project' };
  const ok = await finishTemplateCreation(created, { activate: () => {}, remember: async () => ({ ...created, prefs: { saved: true } }) });
  assert.equal(ok.projectId, created.projectId);
  assert.equal(ok.warnings, undefined);
  const failed = await finishTemplateCreation(created, {
    activate: () => { throw new Error('private path'); },
    remember: () => { throw new Error('secret'); },
  });
  assert.deepEqual(failed, { ...created, warnings: ['TEMPLATE_ACTIVATION_FAILED', 'PREFERENCES_SAVE_FAILED'] });
});

test('a new documented-format template is discovered and copied without registration changes', async t => {
  const { root, parentDir } = await fixture(t);
  const id = 'My_Template.v2';
  const source = join(root, id);
  await mkdir(source);
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ id, title: 'Extension', entry: 'film.html', mode: 'film' }));
  await writeFile(join(source, 'film.html'), 'extension film');
  const listed = await listTemplates(root);
  assert.ok(listed.some(item => item.id === id));
  const created = await installTemplate({ root, id, parentDir, titleFor: () => 'Extension', createProject: async path => ({ id: 'project2', path }) });
  assert.equal(await readFile(join(created.path, 'film.html'), 'utf8'), 'extension film');
  assert.equal(await readFile(join(source, 'film.html'), 'utf8'), 'extension film');
});

test('copies and counts every actual file including nested manifests', async t => {
  const { source, parentDir, args } = await fixture(t);
  await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'manifest.json'), '{}');
  await writeFile(join(source, 'nested', 'manifest.json'), 'nested');
  await writeFile(join(source, 'film.html'), 'hello');
  const a = await installTemplate(args);
  const b = await installTemplate(args);
  assert.notEqual(a.path, b.path);
  assert.equal(a.projectId, 'project');
  assert.equal(a.files, 3);
  assert.equal(a.bytes, 13);
  assert.equal(await readFile(join(a.path, 'nested', 'manifest.json'), 'utf8'), 'nested');
  assert.equal((await readdir(parentDir)).length, 2);
});

test('rejects a symbolic link before registering or creating a target', async t => {
  const { source, parentDir, args, base } = await fixture(t);
  await writeFile(join(base, 'outside'), 'private');
  try { await symlink(join(base, 'outside'), join(source, 'link')); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('symbolic links unavailable'); throw error; }
  let called = false;
  args.createProject = async () => { called = true; };
  await assert.rejects(installTemplate(args), { code: 'TEMPLATE_INPUT' });
  assert.equal(called, false);
  assert.deepEqual(await readdir(parentDir), []);
  assert.equal(await readFile(join(base, 'outside'), 'utf8'), 'private');
});

test('counts manifest bytes toward the limit', async t => {
  const { source, parentDir, args } = await fixture(t);
  const f = await open(join(source, 'manifest.json'), 'w');
  try { await f.truncate(64 * 1024 * 1024 + 1); } finally { await f.close(); }
  await assert.rejects(installTemplate(args), { code: 'TEMPLATE_TOO_LARGE' });
  assert.deepEqual(await readdir(parentDir), []);
});

test('registration failure retains the project and reports uncertainty', async t => {
  const { source, args } = await fixture(t);
  await writeFile(join(source, 'film.html'), 'film');
  args.createProject = async path => { await writeFile(join(path, 'studio-data'), 'registered'); throw new Error('connection lost'); };
  let failure;
  await assert.rejects(installTemplate(args), error => { failure = error; return true; });
  assert.equal(failure.code, 'TEMPLATE_REGISTRATION_UNCERTAIN');
  assert.equal(failure.residual, true);
  assert.equal(failure.registrationUnknown, true);
  assert.match(failure.message, /No files were deleted/);
  assert.equal(await readFile(join(failure.targetPath, 'film.html'), 'utf8'), 'film');
  assert.equal(await readFile(join(failure.targetPath, 'studio-data'), 'utf8'), 'registered');
});

test('rejects project parents inside a template', async t => {
  const { source, args } = await fixture(t);
  args.parentDir = source;
  await assert.rejects(installTemplate(args), { code: 'TEMPLATE_INPUT' });
});

test('dual layout templates share assets but only install the chosen layout under film.html', async t => {
  const { args, source, root } = await fixture(t);
  const layouts = { defaultRatio: '9:16', ratios: ['9:16', '16:9'] };
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ id: 'sample', title: 'Dual layout', entry: 'film.html', mode: 'film', layoutVariants: layouts }));
  await mkdir(join(source, 'assets'));
  await writeFile(join(source, 'assets', 'tokens.css'), 'a{}');
  const shots = [{ id: 'shot-01', title: 'Layout fixture', duration: 5, start: 0 }];
  for (const ratio of layouts.ratios) {
    const layout = selectBundledTemplateLayout(layouts, ratio);
    await mkdir(join(source, layout.pages));
    await writeFile(join(source, layout.pages, 'shot-01.html'), `<p>${ratio}</p>`);
    await writeFile(join(source, layout.entry), shotWall({ title: 'Demo', size: layout.size, shots, pages: layout.pages }));
  }
  const [listing] = await listTemplates(root);
  assert.deepEqual(listing.ratios, layouts.ratios);
  assert.equal(listing.defaultRatio, '9:16');
  const lookups = await templateCatalog(root);
  assert.deepEqual(searchTemplates(lookups, '', 5, { ratio: '16:9' }).map(item => item.id), ['sample']);
  const portrait = await installTemplate(args);
  const landscape = await installTemplate({ ...args, ratio: '16:9' });
  for (const [saved, size, pages] of [[portrait, [1080, 1920], 'pages'], [landscape, [1920, 1080], 'pages-landscape']]) {
    const result = readFilmFile(await readFile(join(saved.path, 'film.html'), 'utf8'));
    assert.deepEqual(result.problems, []);
    assert.deepEqual([result.doc.stage.w, result.doc.stage.h], size);
    assert.equal(result.doc.tracks[0].clips[0].src, `${pages}/shot-01.html`);
    assert.deepEqual((await readdir(saved.path)).sort(), ['assets', 'film.html', 'manifest.json', pages].sort());
    assert.equal(await readFile(join(saved.path, 'assets', 'tokens.css'), 'utf8'), 'a{}');
  }
  assert.equal(portrait.ratio, '9:16');
  assert.equal(landscape.ratio, '16:9');
});

test('an unknown or unbuilt layout never falls back to a different ratio or registers a project', async t => {
  const { args, source, parentDir } = await fixture(t);
  await writeFile(join(source, 'manifest.json'), JSON.stringify({ id: 'sample', layoutVariants: { defaultRatio: '9:16', ratios: ['9:16', '16:9'] } }));
  await mkdir(join(source, 'pages'));
  await writeFile(join(source, 'film.html'), 'portrait');
  args.createProject = () => assert.fail('an invalid layout must not register');
  for (const ratio of ['16:9', '1:1', null, '../../other', ['9:16']]) {
    await assert.rejects(installTemplate({ ...args, ratio }), { code: 'TEMPLATE_INPUT' });
  }
  assert.deepEqual(await readdir(parentDir), []);
});

test('listTemplates honors explicit order and featured flag across real templates', async () => {
  const listed = await listTemplates(new URL('../vendor/templates', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.ok(listed.length > 0);
  assert.equal(listed[0].id, 'vibe-explainer');
  assert.ok(listed.every((item, i) => i === 0 || listed[i - 1].order <= item.order));
  assert.equal(listed[0].featured, true);
});
