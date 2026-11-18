import { existsSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Dev-only SSE hub watching repository-local asset/source files (never `%TEMP%`
 * to avoid libuv 8.3 short-path crashes on Windows) and notifying connected
 * panels in real time.
 */
export function createDevLiveSse({ root = REPO_ROOT, enabled = true } = {}) {
  const clients = new Set();
  const watchers = [];
  const timers = new Map();
  let lastEvent = { type: 'connected', ts: Date.now() };
  let closed = false;

  function broadcast(payload) {
    if (closed) return;
    lastEvent = { ...payload, ts: Date.now() };
    const frame = `data: ${JSON.stringify(lastEvent)}\n\n`;
    for (const res of [...clients]) {
      if (res.destroyed || res.writableEnded) {
        clients.delete(res);
        continue;
      }
      try { res.write(frame); } catch { clients.delete(res); }
    }
  }

  function debounce(key, delayMs, fn) {
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      timers.delete(key);
      if (!closed) fn();
    }, delayMs);
    timer.unref?.();
    timers.set(key, timer);
  }

  function watchTarget(targetPath, options, onHit) {
    if (!existsSync(targetPath)) return;
    try {
      const watcher = watch(targetPath, { persistent: false, ...options }, (_event, filename) => {
        onHit(filename ? String(filename) : '');
      });
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch { /* non-fatal in constrained filesystems */ }
  }

  if (enabled) {
    watchTarget(join(root, 'assets', 'theme'), {}, (file) => {
      if (file && !file.endsWith('.css')) return;
      debounce('theme', 80, () => broadcast({ type: 'theme', file: file || 'theme.css' }));
    });
    watchTarget(join(root, 'brand', 'brand.json'), {}, () => {
      debounce('theme', 80, () => broadcast({ type: 'theme', file: 'brand.json' }));
    });
    watchTarget(join(root, 'assets', 'shell-ui.js'), {}, () => {
      debounce('shell-ui', 120, () => broadcast({ type: 'shell-ui', file: 'assets/shell-ui.js' }));
    });
    watchTarget(join(root, 'client.js'), {}, () => {
      debounce('client-js', 120, () => broadcast({ type: 'client-js', file: 'client.js' }));
    });
    watchTarget(join(root, 'src'), { recursive: true }, (file) => {
      if (!file || !file.endsWith('.mjs') || file.startsWith('dev/') || file.startsWith('dev\\')) return;
      debounce('host-stale', 150, () => broadcast({ type: 'host-stale', file: `src/${file.replace(/\\/g, '/')}` }));
    });
  }

  function attach(req, res) {
    if (closed) { res.writeHead(503).end(); return; }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    res.write(`data: ${JSON.stringify({ type: 'connected', ts: Date.now(), lastEvent })}\n\n`);
    clients.add(res);
    const keepAlive = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        clearInterval(keepAlive);
        clients.delete(res);
        return;
      }
      try { res.write(': ping\n\n'); } catch { clearInterval(keepAlive); clients.delete(res); }
    }, 15_000);
    keepAlive.unref?.();
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
  }

  function close() {
    closed = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const watcher of watchers) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    watchers.length = 0;
    for (const res of [...clients]) {
      try { res.end(); } catch { /* ignore */ }
    }
    clients.clear();
  }

  return Object.freeze({ attach, broadcast, close });
}
