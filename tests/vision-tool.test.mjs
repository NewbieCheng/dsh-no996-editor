import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVisionTools, extractVisionFrame } from '../src/tools/vision-tool.mjs';

// A synthetic PNG header is sufficient for the mocked browser and attachment backend.
const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000008000000060806', 'hex');

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vision-tool-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'project');
  await mkdir(join(path, 'assets'), { recursive: true });
  const source = 'assets/take.mp4';
  const original = Buffer.from('not touched');
  await writeFile(join(path, source), original);
  const agent = {};
  const calls = [];
  const saved = [];
  const [cutout, face] = createVisionTools({
    isProjectAgent: a => a === agent, projectOf: () => ({ path, projectId: 'p' }),
    extract: async (file, at, { workDir, signal }) => {
      calls.push({ file, at, workDir, signal });
      return Buffer.from('source frame');
    },
    browser: async (mode, callback) => callback(async data => {
      assert.equal(data.toString(), 'source frame');
      return mode === 'face'
        ? { width: 8, height: 6, faces: [{ box: { left: 0.1, top: 0.1, right: 0.2, bottom: 0.2 }, points: { nose: { x: 0.15, y: 0.16 } } }] }
        : { width: 8, height: 6, foregroundFraction: 0.23, png: png.toString('base64') };
    }),
    attachments: { saveImage: async input => { saved.push(input); return { attachmentId: 'asset-1', bytes: input.data.length }; } },
    ...overrides,
  });
  return { agent, cutout, face, path, root, source, original, calls, saved };
}

test('cutout is restricted to project media and returns an attachment without changing source', async t => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  const result = await f.cutout.execute({ source: f.source, at: 1.5 }, { agent: f.agent, signal });
  assert.equal(f.calls[0].file, await realpath(join(f.path, f.source)));
  assert.equal(f.calls[0].at, 1.5);
  assert.equal(f.calls[0].signal, signal);
  assert.match(result.path, /^assets\/vision\/cutout-1500ms-[a-f0-9-]+\.png$/);
  assert.ok(result.text.includes(result.path));
  assert.deepEqual(await readFile(join(f.path, result.path)), png);
  assert.deepEqual(f.saved, [{ data: png, name: result.path.split('/').at(-1), mediaType: 'image/png' }]);
  assert.equal(f.cutout.output.render({}, result)[1].attachment.attachmentId, 'asset-1');
  assert.deepEqual(await readFile(f.calls[0].file), f.original);
  await assert.rejects(access(f.calls[0].workDir), { code: 'ENOENT' });
});

test('cutout paths are unique, can work without attachment service, and reject redirecting output directories', async t => {
  const f = await fixture(t, { attachments: undefined });
  const exec = { agent: f.agent };
  const first = await f.cutout.execute({ source: f.source }, exec);
  const second = await f.cutout.execute({ source: f.source }, exec);
  assert.notEqual(first.path, second.path);
  assert.equal(first.image, undefined);
  assert.equal(f.cutout.output.render({}, first).length, 1);
  const out = join(f.root, 'outside');
  await mkdir(out);
  await rm(join(f.path, 'assets', 'vision'), { recursive: true });
  await symlink(out, join(f.path, 'assets', 'vision'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.cutout.execute({ source: f.source }, exec), /输出目录不是项目内/);
  assert.deepEqual(await readFile(join(f.path, f.source)), f.original);
});

test('face analysis samples source times and reports positions without identity or tracking', async t => {
  const f = await fixture(t);
  const result = await f.face.execute({ source: f.source, at: [2, 0, 2] }, { agent: f.agent });
  assert.deepEqual(result.frames.map(frame => frame.at), [2, 0]);
  assert.equal(result.frames[0].faces[0].points.nose.y, 0.16);
  assert.equal(result.frames[0].faces[0].box.right, 0.2);
  assert.deepEqual(f.saved, []);
});

test('outside paths, unbound agents and invalid bounds do not start extraction', async t => {
  const f = await fixture(t);
  const exec = { agent: f.agent };
  await assert.rejects(f.cutout.execute({ source: f.source }, { agent: {} }), /仅对已绑定/);
  for (const source of ['../outside.mp4', 'C:relative.mp4', '/outside.mp4', 'https://example.test/media.mp4']) {
    await assert.rejects(f.cutout.execute({ source }, exec), /相对路径/);
  }
  for (const at of [[], [NaN], [Infinity], ['0'], Array(9).fill(0), [0, -1]]) {
    await assert.rejects(f.face.execute({ source: f.source, at }, exec), /1–8/);
  }
  const outside = join(f.root, 'other');
  await mkdir(outside);
  await writeFile(join(outside, 'outside.mp4'), 'unread');
  await symlink(outside, join(f.path, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.cutout.execute({ source: 'linked/outside.mp4' }, exec), /项目外部/);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(f.cutout.execute({ source: f.source }, { agent: f.agent, signal: stop.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
});

test('cancelled analysis and switched project do not publish output', async t => {
  const controller = new AbortController();
  let workDir;
  let current = 'original';
  const f = await fixture(t, {
    projectOf: () => ({ projectId: current, path: f.path }),
    extract: async (_file, _at, opts) => { workDir = opts.workDir; return Buffer.from('source frame'); },
    browser: async (_mode, callback) => callback(async () => {
      if (current === 'original') controller.abort();
      else current = 'different';
      return { width: 8, height: 6, faces: [] };
    }),
  });
  await assert.rejects(f.face.execute({ source: f.source }, { agent: f.agent, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(access(workDir), { code: 'ENOENT' });
  current = 'changed';
  await assert.rejects(f.face.execute({ source: f.source }, { agent: f.agent }), /项目已切换/);
  await assert.rejects(access(workDir), { code: 'ENOENT' });
});

test('ffmpeg extraction uses an explicit protocol filter and rejects an empty frame', async t => {
  const f = await fixture(t);
  const file = join(f.path, f.source);
  let args;
  const caps = await extractVisionFrame(file, 2.5, { workDir: f.root, resolve: async () => 'mock-ffmpeg', run: async (exe, argv) => {
    assert.equal(exe, 'mock-ffmpeg');
    args = argv;
    await writeFile(argv.at(-1), 'png');
    return { code: 0 };
  } });
  assert.equal(caps.toString(), 'png');
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
  assert.ok(!args[args.indexOf('-format_whitelist') + 1].includes('concat'));
  assert.equal(args[args.indexOf('-ss') + 1], '2.5');
  await assert.rejects(extractVisionFrame(file, 99, { workDir: f.root, resolve: async () => 'mock', run: async () => ({ code: 0 }) }), /超出素材/);
});
