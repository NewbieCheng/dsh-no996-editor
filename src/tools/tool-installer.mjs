/**
 * Getting ffmpeg and ffprobe onto a machine that does not have them.
 *
 * Three places are checked, in this order:
 *   1. the optional packages (`ffmpeg-static`, `ffprobe-static`) that ship with
 *      a normal install — the common case, no network needed;
 *   2. a downloaded executable under <DSH_HOME>/no996-openfilm/tools, for the
 *      machine where optional dependencies were skipped;
 *   3. a package manager's directory (Homebrew, WinGet, scoop, chocolatey) —
 *      "already installed but not found" is almost always this one missing.
 *
 * install() is single-flight and never awaited by the UI: 75 MB is a download,
 * not a request. Every source in `download-sources.mjs` is tried in order, and
 * status() reports bytes, phase, source and speed so the wizard can show what is
 * actually happening instead of "正在开始…".
 */
import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { TOOL_SOURCES, knownBinaryDirs, toolSourceUrls } from '../host/download-sources.mjs';
import { createStallWatch, stallReason, DEFAULT_CONNECT_MS, DEFAULT_IDLE_MS } from '../host/download-stall.mjs';

const EXE = { win32: '.exe', darwin: '', linux: '' };

function packaged(name) {
  try {
    const loaded = createRequire(import.meta.url)(name);
    const candidate = loaded?.path ?? loaded?.default ?? loaded;
    return typeof candidate === 'string' ? candidate : null;
  } catch {
    return null;
  }
}

async function existsFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** Minimal ustar reader: enough for one binary out of an npm tarball. */
export function readTarMember(tar, wanted) {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const name = rawName;
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (name === wanted && (type === '0' || type === '\\u0000')) return body;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

export { TOOL_SOURCES };

export function createToolInstaller({
  home = process.env.DSH_HOME || join(homedir(), '.dsh'),
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  resolvePackaged = packaged,
  now = Date.now,
  connectTimeoutMs = DEFAULT_CONNECT_MS,
  /** No new bytes for this long → stall and try the next source. Total time unbounded. */
  idleTimeoutMs = DEFAULT_IDLE_MS,
} = {}) {
  const dir = join(home, 'no996-openfilm', 'tools');
  const suffix = EXE[platform] ?? '';
  const state = new Map();

  const local = tool => join(dir, tool + suffix);
  const entry = tool => {
    if (!state.has(tool)) {
      state.set(tool, {
        installing: false, phase: 'idle', source: '', received: 0, total: 0, speed: 0,
        attempt: 0, sources: toolSourceUrls(tool, { platform, arch }).length,
        error: '', startedAt: 0, done: false,
      });
    }
    return state.get(tool);
  };

  function resolve(tool) {
    const shipped = resolvePackaged(TOOL_SOURCES[tool]?.package);
    if (shipped) return shipped;
    return null;
  }

  /** Packaged, then downloaded, then a package manager's directory. */
  function resolveAny(tool) {
    const shipped = resolve(tool);
    if (shipped) return { path: shipped, source: 'packaged' };
    const localFile = local(tool);
    if (existsSync(localFile)) return { path: localFile, source: 'downloaded' };
    for (const candidateDir of knownBinaryDirs(platform, process.env)) {
      const candidate = join(candidateDir, tool + suffix);
      if (existsSync(candidate)) return { path: candidate, source: 'system' };
    }
    return null;
  }

  async function localReady(tool) {
    return existsFile(local(tool));
  }

  async function snapshot() {
    const tools = {};
    for (const tool of Object.keys(TOOL_SOURCES)) {
      const current = entry(tool);
      const packed = resolve(tool);
      const localFile = await localReady(tool);
      tools[tool] = {
        ready: Boolean(packed) || localFile,
        local: localFile ? local(tool) : '',
        source: packed ? 'packaged' : localFile ? 'downloaded' : '',
        installing: current.installing,
        phase: current.phase,
        sourceId: current.source,
        received: current.received,
        total: current.total,
        speed: current.speed,
        attempt: current.attempt,
        sources: current.sources,
        error: current.error,
      };
    }
    return { dir, tools };
  }

  function memberFor(tool) {
    if (tool === 'ffmpeg') {
      return `package/ffmpeg${suffix}`;
    }
    const archName = arch === 'arm64' ? 'arm64' : 'x64';
    return `package/bin/${platform}/${archName}/ffprobe${suffix}`;
  }

  async function download(tool, current) {
    const urls = toolSourceUrls(tool, { platform, arch });
    const failures = [];
    for (const [index, source] of urls.entries()) {
      current.attempt = index + 1;
      current.source = source.id;
      current.phase = 'connecting';
      current.received = 0;
      current.total = 0;
      current.speed = 0;
      const stall = createStallWatch({
        connectMs: connectTimeoutMs,
        idleMs: idleTimeoutMs,
        now,
      });
      try {
        const response = await fetchImpl(source.url, { redirect: 'follow', signal: stall.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        stall.connected();
        current.phase = 'downloading';
        const chunks = [];
        let received = 0;
        let lastAt = now();
        let lastBytes = 0;
        const onBytes = (bytes, total) => {
          stall.activity();
          const at = now();
          const seconds = (at - lastAt) / 1000;
          if (seconds >= 0.4) {
            current.speed = Math.max(0, (bytes - lastBytes) / seconds);
            lastAt = at;
            lastBytes = bytes;
          }
          current.received = bytes;
          current.total = total;
        };
        if (response.body && typeof response.body.getReader === 'function') {
          const reader = response.body.getReader();
          const abortRead = () => {
            const reason = stallReason(stall.signal.reason) || stall.signal.reason
              || Object.assign(new Error('下载已中止'), { code: 'DOWNLOAD_STALL' });
            try { reader.cancel?.(reason); } catch { /* ignore */ }
            return reason;
          };
          if (stall.signal.aborted) throw abortRead();
          const onAbort = () => { abortRead(); };
          stall.signal.addEventListener('abort', onAbort, { once: true });
          try {
            for (;;) {
              if (stall.signal.aborted) throw abortRead();
              const chunk = await Promise.race([
                reader.read(),
                new Promise((_, reject) => {
                  if (stall.signal.aborted) reject(abortRead());
                  else stall.signal.addEventListener('abort', () => reject(abortRead()), { once: true });
                }),
              ]);
              const { done, value } = chunk;
              if (done) break;
              chunks.push(Buffer.from(value));
              received += value.byteLength;
              onBytes(received, Number(response.headers?.get?.('content-length')) || 0);
            }
          } finally {
            stall.signal.removeEventListener('abort', onAbort);
          }
        } else {
          // No streaming body: whole buffer is one activity pulse after headers.
          stall.activity();
          const buffer = Buffer.from(await Promise.race([
            response.arrayBuffer(),
            new Promise((_, reject) => {
              if (stall.signal.aborted) {
                reject(stallReason(stall.signal.reason) || stall.signal.reason);
                return;
              }
              stall.signal.addEventListener('abort', () => {
                reject(stallReason(stall.signal.reason) || stall.signal.reason);
              }, { once: true });
            }),
          ]));
          chunks.push(buffer);
          received = buffer.byteLength;
          onBytes(received, received);
        }
        stall.clear();
        const gz = Buffer.concat(chunks);
        current.phase = 'verifying';
        if (tool === 'ffmpeg') return { binary: gunzipSync(gz), source: source.id };
        const member = readTarMember(gunzipSync(gz), memberFor(tool));
        if (!member) throw new Error('压缩包里没有 ffprobe');
        return { binary: member, source: source.id };
      } catch (error) {
        stall.clear();
        const stalled = stallReason(error) || (error?.name === 'AbortError' ? stallReason(error.cause) : null);
        const message = stalled
          ? stalled.message
          : String(error?.message || error).slice(0, 120);
        failures.push(source.id + ': ' + message);
      }
    }
    throw new Error('所有下载源都失败（' + failures.join('；') + '）');
  }

  async function runInstall(tool) {
    const current = entry(tool);
    current.installing = true;
    current.phase = 'connecting';
    current.error = '';
    current.received = 0;
    current.total = 0;
    current.speed = 0;
    current.source = '';
    current.attempt = 0;
    current.startedAt = now();
    current.done = false;
    try {
      if (resolve(tool)) { current.phase = 'done'; current.done = true; return; }
      if (await localReady(tool)) { current.phase = 'done'; current.done = true; return; }
      const { binary, source } = await download(tool, current);
      current.source = source;
      current.phase = 'verifying';
      await mkdir(dir, { recursive: true });
      const target = local(tool);
      const temp = target + '.part';
      await writeFile(temp, binary);
      await rename(temp, target);
      if (platform !== 'win32') await chmod(target, 0o755);
      current.done = true;
      current.phase = 'done';
      current.received = binary.byteLength;
      current.total = binary.byteLength;
    } catch (error) {
      current.phase = 'failed';
      current.error = String(error?.message || error).slice(0, 300);
      current.done = false;
    } finally {
      current.installing = false;
    }
  }

  const flights = new Map();

  /** Start (or join) an install. The UI polls status(); it never awaits this. */
  function install(tool) {
    if (!TOOL_SOURCES[tool]) return Promise.reject(new Error('未知组件：' + tool));
    if (flights.has(tool)) return flights.get(tool);
    const flight = runInstall(tool).finally(() => flights.delete(tool));
    flights.set(tool, flight);
    return flight;
  }

  return { dir, resolve, resolveAny, localReady, snapshot, install, memberFor };
}
