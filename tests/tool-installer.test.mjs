import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createToolInstaller, readTarMember } from '../src/tools/tool-installer.mjs';

function block(name, body) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100, 'utf8');
  header.write(String(body.length).padStart(11, '0') + '\0', 124, 'utf8');
  header[156] = '0'.charCodeAt(0);
  header.write('0000000\0', 148, 'utf8');
  header.write('0000000\0', 156, 'utf8');
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

function tarGz(members) {
  const parts = members.map(([name, body]) => block(name, Buffer.from(body)));
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const noPackages = () => null;

test('readTarMember finds one file and ignores the rest', () => {
  const tar = gzipSync(Buffer.concat([
    block('package/README.md', Buffer.from('readme')),
    block('package/bin/win32/x64/ffprobe.exe', Buffer.from('FFPROBE')),
    Buffer.alloc(1024),
  ]));
  const found = readTarMember(gunzipSync(tar), 'package/bin/win32/x64/ffprobe.exe');
  assert.equal(found.toString(), 'FFPROBE');
});

test('downloads ffprobe from the npm tarball when the package is absent', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-tools-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const tarball = tarGz([['package/bin/win32/x64/ffprobe.exe', 'BINARY']]);
  const installer = createToolInstaller({
    home, platform: 'win32', arch: 'x64', resolvePackaged: noPackages,
    fetchImpl: async () => ({ ok: true, headers: new Map([['content-length', String(tarball.length)]]), arrayBuffer: async () => tarball }),
  });
  assert.equal((await installer.snapshot()).tools.ffprobe.ready, false);
  await installer.install('ffprobe');
  const snap = await installer.snapshot();
  assert.equal(snap.tools.ffprobe.ready, true);
  assert.equal(snap.tools.ffprobe.source, 'downloaded');
  assert.equal(readFileSync(join(home, 'no996-openfilm', 'tools', 'ffprobe.exe'), 'utf8'), 'BINARY');
});

test('ffmpeg gz is unpacked as a plain binary', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-tools-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const gz = gzipSync(Buffer.from('FFMPEG'));
  const installer = createToolInstaller({
    home, platform: 'win32', arch: 'x64', resolvePackaged: noPackages,
    fetchImpl: async () => ({ ok: true, headers: new Map(), arrayBuffer: async () => gz }),
  });
  await installer.install('ffmpeg');
  assert.equal(readFileSync(join(home, 'no996-openfilm', 'tools', 'ffmpeg.exe'), 'utf8'), 'FFMPEG');
});

test('a failed download is reported and a retry can still succeed', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-tools-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let calls = 0;
  const ok = gzipSync(Buffer.from('FFMPEG'));
  const installer = createToolInstaller({
    home, platform: 'linux', arch: 'x64', resolvePackaged: noPackages,
    fetchImpl: async () => {
      calls += 1;
      // Both sources fail on the first attempt; the retry reaches the second.
      if (calls <= 2) throw new Error('network down');
      return { ok: true, headers: new Map(), arrayBuffer: async () => ok };
    },
  });
  await installer.install('ffmpeg');
  let snap = await installer.snapshot();
  assert.equal(snap.tools.ffmpeg.ready, false);
  assert.match(snap.tools.ffmpeg.error, /所有下载源都失败/);
  assert.match(snap.tools.ffmpeg.error, /network down/);
  await installer.install('ffmpeg');
  snap = await installer.snapshot();
  assert.equal(snap.tools.ffmpeg.ready, true);
  assert.equal(snap.tools.ffmpeg.error, '');
});

test('the next source is used when the first one fails', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-tools-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const gz = gzipSync(Buffer.from('FFMPEG'));
  const urls = [];
  const installer = createToolInstaller({
    home, platform: 'win32', arch: 'x64', resolvePackaged: noPackages,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.includes('npmmirror')) throw new Error('mirror down');
      return { ok: true, headers: new Map(), arrayBuffer: async () => gz };
    },
  });
  await installer.install('ffmpeg');
  const snap = await installer.snapshot();
  assert.equal(snap.tools.ffmpeg.ready, true);
  assert.equal(snap.tools.ffmpeg.sourceId, 'github');
  assert.equal(snap.tools.ffmpeg.phase, 'done');
  assert.equal(urls.length, 2);
  assert.match(urls[0], /npmmirror/);
});

test('a downloaded binary is found without PATH', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-tools-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, 'no996-openfilm', 'tools');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ffmpeg.exe'), 'BINARY');
  const installer = createToolInstaller({ home, platform: 'win32', resolvePackaged: noPackages });
  const found = installer.resolveAny('ffmpeg');
  assert.equal(found?.source, 'downloaded');
  assert.equal(found?.path, join(dir, 'ffmpeg.exe'));
});

test('a packaged binary needs no network and is reported as packaged', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-tools-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const installer = createToolInstaller({
    home, resolvePackaged: name => (name === 'ffmpeg-static' ? '/opt/ffmpeg' : null),
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  const snap = await installer.snapshot();
  assert.equal(snap.tools.ffmpeg.ready, true);
  assert.equal(snap.tools.ffmpeg.source, 'packaged');
  await installer.install('ffmpeg');
});

function hangingBody() {
  let rejectPending = null;
  return {
    getReader() {
      return {
        read() {
          return new Promise((_, reject) => { rejectPending = reject; });
        },
        cancel(reason) {
          rejectPending?.(reason || Object.assign(new Error('cancelled'), { code: 'DOWNLOAD_STALL' }));
        },
      };
    },
  };
}

test('a stalled body aborts that source and the next source can still win', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-tools-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const gz = gzipSync(Buffer.from('FFMPEG'));
  const urls = [];
  const installer = createToolInstaller({
    home, platform: 'win32', arch: 'x64', resolvePackaged: noPackages,
    connectTimeoutMs: 200, idleTimeoutMs: 40,
    fetchImpl: async (url, { signal } = {}) => {
      urls.push(url);
      if (url.includes('npmmirror')) {
        return { ok: true, headers: new Map([['content-length', '999']]), body: hangingBody() };
      }
      return { ok: true, headers: new Map(), arrayBuffer: async () => {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return gz;
      } };
    },
  });
  await installer.install('ffmpeg');
  const snap = await installer.snapshot();
  assert.equal(snap.tools.ffmpeg.ready, true);
  assert.equal(snap.tools.ffmpeg.sourceId, 'github');
  assert.equal(urls.length, 2);
  assert.match(urls[0], /npmmirror/);
});

test('a hung connect aborts and tries the next source', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'openfilm-tools-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const gz = gzipSync(Buffer.from('FFMPEG'));
  const installer = createToolInstaller({
    home, platform: 'win32', arch: 'x64', resolvePackaged: noPackages,
    connectTimeoutMs: 40, idleTimeoutMs: 500,
    fetchImpl: async (url, { signal } = {}) => {
      if (url.includes('npmmirror')) {
        await new Promise((resolve, reject) => {
          const onAbort = () => reject(Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
            cause: signal?.reason,
          }));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      return { ok: true, headers: new Map(), arrayBuffer: async () => gz };
    },
  });
  await installer.install('ffmpeg');
  const snap = await installer.snapshot();
  assert.equal(snap.tools.ffmpeg.ready, true);
  assert.equal(snap.tools.ffmpeg.sourceId, 'github');
});
