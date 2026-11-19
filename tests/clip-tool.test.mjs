import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClipTool, filmIdentity } from '../src/tools/clip-tool.mjs';

const source = `<!doctype html>
<html><head><style>/* keep */ .x { color: red }</style></head>
<body>
<section id='one'>
  <video data-note='hello' id='a' src='a.mp4#t=1,9' at='1' class='x'></video>
  <audio id='b' src='b.wav#t=0,3' at='20'></audio>
</section>
<section id='two'></section>
</body></html>`;

const agent = { id: 'session-a' };

async function project(t, { content = source, path } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-clip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path ? join(root, path) : root;
  if (path) { await (await import('node:fs/promises')).mkdir(dir, { recursive: true }); }
  if (content !== null) await writeFile(join(dir, 'film.html'), content, 'utf8');
  return dir;
}

const tool = createClipTool({
  isProjectAgent: candidate => candidate?.id === 'session-a',
  projectOf: candidate => (candidate?.id === 'session-a' && candidate.dir ? { projectId: 'film123', path: candidate.dir } : undefined),
});

const run = (dir, args) => tool.execute(args, { agent: { ...agent, dir } });
const identity = async dir => filmIdentity(join(dir, 'film.html'));

test('an edit is saved atomically and only the clip tag changes', async t => {
  const dir = await project(t);
  const before = await readFile(join(dir, 'film.html'), 'utf8');
  const value = await run(dir, { operations: [{ op: 'move', clip: 'a', at: 2 }] });
  const after = await readFile(join(dir, 'film.html'), 'utf8');
  assert.equal(after, before.replace("at='1'", 'at="2"'));
  assert.match(value.text, /已保存：1 步/);
  // The comment, the head and the other clip are byte-identical.
  assert.ok(after.includes('<style>/* keep */ .x { color: red }</style>'));
  assert.ok(after.includes("<audio id='b' src='b.wav#t=0,3' at='20'></audio>"));
});

test('a stale baseline is refused and the file is left alone', async t => {
  const dir = await project(t);
  const original = await readFile(join(dir, 'film.html'), 'utf8');
  await assert.rejects(run(dir, { operations: [{ op: 'move', clip: 'a', at: 5 }], expect: { hash: 'deadbeef' } }), /没有动文件/);
  assert.equal(await readFile(join(dir, 'film.html'), 'utf8'), original);
});

test('the hash a save returns is usable as the next baseline', async t => {
  const dir = await project(t);
  const first = await run(dir, { operations: [{ op: 'move', clip: 'a', at: 2 }] });
  const hash = /新基线：([0-9a-f]+)/.exec(first.text)?.[1];
  assert.ok(hash, first.text);
  await run(dir, { operations: [{ op: 'move', clip: 'a', at: 3 }], expect: { hash } });
  assert.match(await readFile(join(dir, 'film.html'), 'utf8'), /at="3"/);
  // The old baseline is now stale.
  await assert.rejects(run(dir, { operations: [{ op: 'move', clip: 'a', at: 4 }], expect: { hash } }), /没有动文件/);
});

test('a dry run reports the change without writing', async t => {
  const dir = await project(t);
  const original = await identity(dir);
  const value = await run(dir, { operations: [{ op: 'trim', clip: 'a', start: 2, end: 8 }], dryRun: true });
  assert.match(value.text, /试算（未保存）/);
  assert.deepEqual(await identity(dir), original);
});

test('a locked track is refused with the editor\'s reason', async t => {
  const dir = await project(t, { content: source.replace("<section id='two'>", "<section id='two' locked>") });
  const original = await readFile(join(dir, 'film.html'), 'utf8');
  await assert.rejects(run(dir, { operations: [{ op: 'move', clip: 'a', at: 1, track: 1 }] }), /冲突.*locked/);
  assert.equal(await readFile(join(dir, 'film.html'), 'utf8'), original);
});

test('an edit that changes nothing does not touch the file', async t => {
  const dir = await project(t);
  const before = await stat(join(dir, 'film.html'));
  const value = await run(dir, { operations: [{ op: 'move', clip: 'a', at: 1 }] });
  const after = await stat(join(dir, 'film.html'));
  assert.match(value.text, /没有改变影片/);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test('a film written by someone else between draft and save is not overwritten', async t => {
  const dir = await project(t);
  // Simulate Studio saving while we drafted: the tool's pre-rename check sees it.
  const original = await readFile(join(dir, 'film.html'), 'utf8');
  const racing = createClipTool({
    isProjectAgent: () => true,
    projectOf: () => ({ projectId: 'film123', path: dir }),
  });
  const pending = racing.execute({ operations: [{ op: 'move', clip: 'a', at: 7 }] }, { agent });
  await writeFile(join(dir, 'film.html'), `${original}\n<!-- person saved -->`, 'utf8');
  // Either guard may catch it (while reading, or just before the rename); both
  // refuse, and both leave the person's save alone.
  await assert.rejects(pending, /没有动它|被改动了/);
  assert.match(await readFile(join(dir, 'film.html'), 'utf8'), /person saved/);
});

test('a missing film says how to make one instead of creating a broken one', async t => {
  const dir = await project(t, { content: null });
  await assert.rejects(run(dir, { operations: [{ op: 'move', clip: 'a', at: 2 }] }), /还没有 film\.html/);
});

test('an unbound conversation cannot write', async () => {
  await assert.rejects(tool.execute({ operations: [{ op: 'move', clip: 'a', at: 2 }] }, { agent: { id: 'nope' } }), /only to a conversation bound/);
});

test('insert and preset mount wordart, fonts, LUT filters, and CSS keyframes via Studio /edit', async t => {
  const dir = await project(t);
  const calls = [];
  const fakeFilm = {
    rev: '1111222233334444',
    doc: {
      tracks: [
        { clips: [{ id: 'v1', src: 'assets/shot.mp4', at: 0, time: [0, 5] }] },
        { locked: true, clips: [{ id: 'locked-clip', src: 'assets/bg.mp4', at: 0, time: [0, 5] }] },
      ],
    },
  };
  const studioClipTool = createClipTool({
    isProjectAgent: candidate => candidate?.id === 'session-a',
    projectOf: candidate => (candidate?.id === 'session-a' ? { projectId: 'film123', path: dir } : undefined),
    http: () => ({
      async get(path) {
        calls.push({ method: 'GET', path });
        return fakeFilm;
      },
      async post(path, { body }) {
        calls.push({ method: 'POST', path, body });
        if (path.endsWith('/saved/take')) {
          if (body.path === 'openfilm/text/text') return { clip: { src: 'saved/openfilm/text-text/text.html', time: [0, 3] } };
          if (body.path === 'openfilm/filters/warm-film') return { clip: { src: 'saved/openfilm/filters-warm-film/layer.html', time: [0, 3] } };
        }
        return { rev: 'aaaabbbbccccdddd', doc: fakeFilm.doc };
      },
    }),
  });

  assert.equal(studioClipTool.name, 'no996_clip');

  const res = await studioClipTool.execute({
    operations: [
      {
        op: 'insert',
        src: 'openfilm/text/text',
        wordart: 'openfilm/text/looks/gold',
        textmotion: 'openfilm/text/motions/in-pop',
        font: "'Smiley Sans', sans-serif",
        text: '不加班科普',
        at: 0.5,
        duration: 3,
        newTrack: 0,
      },
      {
        op: 'insert',
        src: 'openfilm/filters/warm-film',
        amount: 0.85,
        at: 0,
        duration: 5,
        newTrack: 0,
      },
      {
        op: 'preset',
        clip: 'v1',
        motion: 'openfilm/motions/in-fade',
      },
    ],
    expect: { revision: '1111222233334444' },
  }, { agent: { ...agent, dir } });

  assert.match(res.text, /已保存 Studio 编辑：3 步/);
  assert.match(res.text, /aaaabbbbccccdddd/);

  const editCall = calls.find(c => c.path.endsWith('/edit'));
  assert.ok(editCall);
  const ops = editCall.body.ops;
  const wordartInsert = ops.find(o => o.op === 'insert' && o.clip?.src?.includes('text-text'));
  assert.ok(wordartInsert);
  const rootOv = wordartInsert.clip.overrides.find(o => o.at === ':root');
  assert.match(rootOv.style['--fill'], /linear-gradient/);
  assert.equal(rootOv.style['--in'], 'pop');
  assert.equal(rootOv.style['--font'], "'Smiley Sans', sans-serif");
  assert.equal(rootOv.style['--clip-length'], '3s');
  assert.deepEqual(wordartInsert.clip.overrides.find(o => o.at === '.t'), { at: '.t', text: '不加班科普' });

  const filterInsert = ops.find(o => o.op === 'insert' && o.clip?.src?.includes('filters-warm-film'));
  assert.ok(filterInsert);
  assert.match(filterInsert.clip.style, /backdrop-filter: url\("data:image\/svg\+xml,.*#openfilm-look"\)/);

  const kfOp = ops.find(o => o.op === 'keyframes');
  assert.ok(kfOp?.set['motion-in-fade']);

  // Stale revision and locked track must both be refused cleanly.
  await assert.rejects(
    studioClipTool.execute({
      operations: [{ op: 'preset', clip: 'v1', text: 'x' }],
      expect: { revision: 'deadbeefdeadbeef' },
    }, { agent }),
    /版本已变化/,
  );
  await assert.rejects(
    studioClipTool.execute({
      operations: [{ op: 'preset', clip: 'locked-clip', volume: 0.2 }],
    }, { agent }),
    /已锁定/,
  );
});
