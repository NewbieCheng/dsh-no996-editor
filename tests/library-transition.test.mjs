import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { planLibraryTransition } from '../src/film/library-transition.mjs';
import { createLibraryTool } from '../src/tools/library-tool.mjs';

const item = { cat: 'transition', kind: 'page', place: 'cut', durationMs: 600 };
const clip = { src: 'saved/openfilm/transitions-glitch/glitch.html' };
const film = () => ({ rev: '0123456789abcdef', doc: { tracks: [{ clips: [
  { id: 'a', src: 'a.mp4', at: 0, time: [0, 3] },
  { id: 'b', src: 'b.mp4', at: 3, time: [0, 3] },
] }] } });
const plan = (override = {}) => planLibraryTransition({ film: film(), item, clip, before: 'a', after: 'b', expect: '0123456789abcdef', ...override });
/** A one-frame page as a film clip can carry it. */
const pageFilm = label => `<!doctype html><html><body>${label}<script>window.film={width:1280,height:720,duration:3,ready:Promise.resolve(),frame(){}};</script></body></html>`;

test('the transition is centered on the cut and guarded by the original revision', () => {
  const result = plan();
  assert.equal(result.cut, 3);
  assert.deepEqual(result.ops[0], { op: 'track-layout', at: 0, from: [['a', 'b']], to: [['a', 'b']] });
  assert.deepEqual(result.ops[1], { op: 'insert', clip: { ...clip, time: [0, 0.6] }, at: 2.7, newTrack: 0 });
});

test('locked, changed, uncertain, nonadjacent or unsupported cuts are refused', () => {
  assert.throws(() => plan({ expect: 'wrong' }), /版本/);
  const locked = film(); locked.doc.tracks[0].locked = true;
  assert.throws(() => plan({ film: locked }), /锁定/);
  const unknown = film(); delete unknown.doc.tracks[0].clips[0].time;
  assert.throws(() => plan({ film: unknown }), /源时间/);
  const gap = film(); gap.doc.tracks[0].clips[1].at = 4;
  assert.throws(() => plan({ film: gap }), /不相接/);
  const extra = film(); extra.doc.tracks[0].clips.splice(1, 0, { id: 'x', src: 'x.mp4', at: 2.9, time: [0, 0.1] });
  assert.throws(() => plan({ film: extra }), /相邻/);
  assert.throws(() => plan({ item: { ...item, kind: 'fade' } }), /页面转场/);
});

test('an old matching transition and an unchanged response are not a successful new edit', async () => {
  const prior = film();
  prior.doc.tracks.unshift({ clips: [{ ...clip, id: 'old-transition', at: 2.7, time: [0, 0.6] }] });
  let response = { rev: prior.rev, doc: prior.doc };
  const calls = [];
  const http = () => ({
    async get(path) { return path === '/api/library' ? { items: [{ ...item, id: 'transitions/glitch' }] } : prior; },
    async post(path) { calls.push(path); return path.endsWith('/saved/take') ? { clip } : response; },
  });
  const tool = createLibraryTool({ isProjectAgent: () => true, projectOf: () => ({ projectId: 'film123', path: '/fixture' }), http });
  const args = { kind: 'transition', take: 'openfilm/transitions/glitch', cut: { before: 'a', after: 'b', revision: prior.rev, saved: true } };
  await assert.rejects(tool.execute(args, { agent: {} }), /未返回可验证的新影片版本/);
  response = { rev: 'fedcba9876543210', doc: prior.doc };
  await assert.rejects(tool.execute(args, { agent: {} }), /未找到新增的目标转场/);
  assert.equal(calls.filter(path => path.endsWith('/edit')).length, 2);
});

test('empty take receipts and lost edit responses never claim success', async () => {
  const prior = film();
  let take = { clips: [] }, edits = 0;
  const http = () => ({
    async get(path) { return path === '/api/library' ? { items: [{ ...item, id: 'transitions/glitch' }] } : prior; },
    async post(path) {
      if (path.endsWith('/saved/take')) return take;
      edits += 1;
      throw new Error('connection lost');
    },
  });
  const tool = createLibraryTool({ isProjectAgent: () => true, projectOf: () => ({ projectId: 'film123', path: '/fixture' }), http });
  const args = { kind: 'transition', take: 'openfilm/transitions/glitch', cut: { before: 'a', after: 'b', revision: prior.rev, saved: true } };
  await assert.rejects(tool.execute(args, { agent: {} }), /未返回可用结果/);
  assert.equal(edits, 0);
  take = { clip };
  await assert.rejects(tool.execute(args, { agent: {} }), /不要直接重试/);
  assert.equal(edits, 1);
});

test('real pinned OpenFilm search, take and strict edit operate only on a temporary film', async () => {
  const root = mkdtempSync(join(tmpdir(), 'no996-transition-'));
  const priorHome = process.env.OPENFILM_HOME;
  const priorShared = process.env.OPENFILM_SHARED_HOME;
  process.env.OPENFILM_HOME = join(root, 'home');
  process.env.OPENFILM_SHARED_HOME = join(root, 'home');
  try {
    const require = createRequire(import.meta.url);
    const pkg = dirname(require.resolve('openfilm/package.json'));
    const load = relative => import(pathToFileURL(join(pkg, relative)).href);
    const { libraryGet } = await load('src/library-search.mjs');
    const { libraryIndex } = await load('studio/server/library.mjs');
    const { takeSaved } = await load('studio/server/saved.mjs');
    const { filmHtml } = await load('src/film-doc.mjs');
    const { readProjectFilm, editProjectFilm } = await load('studio/server/film.mjs');
    const project = join(root, 'film');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(project);
    writeFileSync(join(project, 'film.html'), filmHtml({ stage: { w: 1920, h: 1080 }, tracks: [{ clips: film().doc.tracks[0].clips }] }));
    const http = () => ({
      async get(path) {
        if (path === '/api/library') return libraryIndex();
        if (path === '/api/projects/film123') return readProjectFilm(project);
        throw new Error(`unexpected GET ${path}`);
      },
      async post(path, { body }) {
        if (path === '/api/get/library') return libraryGet(body.verb, body.args);
        if (path === '/api/projects/film123/saved/take') return takeSaved(project, body.path);
        if (path === '/api/projects/film123/edit') return editProjectFilm(project, body.base, body.ops);
        throw new Error(`unexpected POST ${path}`);
      },
    });
    const tool = createLibraryTool({ isProjectAgent: () => true, projectOf: () => ({ projectId: 'film123', path: project }), http });
    const found = await tool.execute({ kind: 'transition', query: 'glitch' }, { agent: {} });
    assert.match(found.text, /openfilm\/transitions\/glitch/);
    const snapshot = await readProjectFilm(project);
    const revision = snapshot.rev;
    const guarded = planLibraryTransition({ film: snapshot, item, clip, before: 'a', after: 'b', expect: revision });
    const concurrent = `${snapshot.text}\n<!-- another editor -->\n`;
    writeFileSync(join(project, 'film.html'), concurrent);
    await assert.rejects(editProjectFilm(project, revision, guarded.ops), error => error.kind === 'conflict');
    assert.equal(readFileSync(join(project, 'film.html'), 'utf8'), concurrent, 'a newer file is never overwritten');
    writeFileSync(join(project, 'film.html'), snapshot.text);
    const result = await tool.execute({ kind: 'transition', take: 'openfilm/transitions/glitch', cut: { before: 'a', after: 'b', revision, saved: true } }, { agent: {} });
    assert.match(result.text, /已放入切点 3 秒/);
    const after = await readProjectFilm(project);
    assert.equal(after.doc.tracks.length, 2);
    assert.match(after.doc.tracks[0].clips[0].src, /transitions-glitch/);
    assert.equal(after.doc.tracks[0].clips[0].at, 2.7);
    assert.deepEqual(after.doc.tracks[1].clips.map(c => c.id), ['a', 'b']);
    const bytes = readFileSync(join(project, 'film.html'), 'utf8');
    await assert.rejects(tool.execute({ kind: 'transition', take: 'openfilm/transitions/glitch', cut: { before: 'a', after: 'b', revision, saved: true } }, { agent: {} }), /版本已变化/);
    assert.equal(readFileSync(join(project, 'film.html'), 'utf8'), bytes);

    // A locked track is refused before anything is copied or written: the tool
    // must not rely on the server to undo a copy it already made.
    const lockedPath = join(root, 'film-locked');
    mkdirSync(lockedPath);
    writeFileSync(join(lockedPath, 'a.html'), pageFilm('a'));
    writeFileSync(join(lockedPath, 'b.html'), pageFilm('b'));
    writeFileSync(join(lockedPath, 'film.html'), filmHtml({ stage: { w: 1280, h: 720 }, tracks: [{ locked: true, clips: [
      { id: 'a', src: 'a.html', at: 0, time: [0, 3] },
      { id: 'b', src: 'b.html', at: 3, time: [0, 3] },
    ] }] }));
    const lockedSnapshot = await readProjectFilm(lockedPath);
    const lockedHttp = () => ({
      async get(path) {
        if (path === '/api/library') return libraryIndex();
        if (path === '/api/projects/film123') return lockedSnapshot;
        throw new Error(`unexpected GET ${path}`);
      },
      async post(path, { body }) {
        if (path === '/api/get/library') return libraryGet(body.verb, body.args);
        throw new Error(`the tool must not call ${path} on a locked track`);
      },
    });
    const lockedTool = createLibraryTool({ isProjectAgent: () => true, projectOf: () => ({ projectId: 'film123', path: lockedPath }), http: lockedHttp });
    await assert.rejects(lockedTool.execute({ kind: 'transition', take: 'openfilm/transitions/glitch', cut: { before: 'a', after: 'b', revision: lockedSnapshot.rev, saved: true } }, { agent: {} }), /锁定/);
    assert.equal(readFileSync(join(lockedPath, 'film.html'), 'utf8'), lockedSnapshot.text);
    assert.deepEqual(readdirSync(lockedPath).sort(), ['a.html', 'b.html', 'film.html']);
  } finally {
    if (priorHome === undefined) delete process.env.OPENFILM_HOME; else process.env.OPENFILM_HOME = priorHome;
    if (priorShared === undefined) delete process.env.OPENFILM_SHARED_HOME; else process.env.OPENFILM_SHARED_HOME = priorShared;
    rmSync(root, { recursive: true, force: true });
  }
});
