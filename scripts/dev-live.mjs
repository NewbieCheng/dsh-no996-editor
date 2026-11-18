#!/usr/bin/env node
/**
 * Unified real-time dev loop for No996 Studio / OpenFilm:
 *
 *   1. Ensures `.upstream/openfilm` exists (applies `patches/*.patch` ONLY if clean;
 *      never overwrites developer's active edits).
 *   2. Launches Vite Dev Server (`shell/vite.config.ts` with React Fast Refresh &
 *      `twoTrees()`) via Vite's Node API on loopback `127.0.0.1:47825` with HMR
 *      path `/__dsh_vite_hmr` (zero untracked files in checkout, no pnpm/corepack).
 *   3. Runs `esbuild` watch for `src/studio/studio-entry.js` -> `client.js` and
 *      watches `src/` Host modules (touching graph for DSH reload) & `assets/`.
 *
 * Usage:
 *   npm run dev:live [-- --vite-port 47825 --poll --dir <checkout>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { context as esbuildContext } from 'esbuild';
import { patchFiles } from './upstream.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const poll = process.argv.includes('--poll');
const vitePort = Number(argValue('--vite-port', process.env.NO996_OPENFILM_VITE_PORT || '47825'));
const devPortalPort = Number(process.env.NO996_OPENFILM_DEBUG_PORT || '47821');
const devPortalUrl = `http://127.0.0.1:${devPortalPort}/`;
const checkout = resolve(argValue('--dir', process.env.NO996_UPSTREAM_DIR || join(ROOT, '.upstream', 'openfilm')));

if (!Number.isInteger(vitePort) || vitePort < 1024 || vitePort > 65534) {
  console.error(`dev-live: invalid --vite-port ${vitePort}`);
  process.exit(1);
}
if (!existsSync(join(checkout, '.git'))) {
  console.error(`dev-live: missing upstream checkout at ${checkout}; run: npm run upstream:fetch`);
  process.exit(1);
}

const git = (...args) => execFileSync('git', ['-C', checkout, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
}).trim();

const porcelain = git('status', '--porcelain', '--untracked-files=all');
if (!porcelain) {
  const patches = patchFiles(ROOT);
  for (const patch of patches) {
    git('apply', '--whitespace=nowarn', patch.path);
  }
  console.log(`[dev-live] applied ${patches.length} patch(es) onto clean upstream checkout`);
} else {
  console.log('[dev-live] upstream checkout already has local edits; preserving working tree');
}

const viteEntry = join(checkout, 'apps', 'desktop', 'node_modules', 'vite', 'dist', 'node', 'index.js');
if (!existsSync(viteEntry)) {
  console.error(`dev-live: missing Vite at ${viteEntry}; install dependencies in ${checkout}`);
  process.exit(1);
}

const { createServer } = await import(pathToFileURL(viteEntry).href);
const viteConfigFile = join(checkout, 'apps', 'desktop', 'shell', 'vite.config.ts');

const directAccessRedirectPlugin = {
  name: 'no996-redirect-direct-browser',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.headers['x-no996-vite-proxy'] === '1') return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const urlPath = String(req.url || '/').split('?')[0];
      const isHtmlRoute = urlPath === '/' || /^\/projects\/[A-Za-z0-9_-]{6,40}\/?$/.test(urlPath);
      const dest = String(req.headers['sec-fetch-dest'] || '');
      if (!isHtmlRoute || (dest && dest !== 'document' && dest !== 'iframe')) return next();
      const target = `${devPortalUrl.replace(/\/$/, '')}${req.url || '/'}`;
      const html = '<!doctype html><meta charset="utf-8"><title>正在跳转到 OpenFilm 开发者工作台…</title>'
        + `<meta http-equiv="refresh" content="0;url=${target}">`
        + '<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#141414;color:#e5e5e5;font:14px/1.6 system-ui,sans-serif;text-align:center}a{color:#38bdf8}</style>'
        + `<div><p><strong>:${vitePort}</strong> 是 Vite 内部热更新引擎，不能独立运行。</p>`
        + `<p>正在跳转到通过 DSH 后端开放的开发者工作台：<a href="${target}">${target}</a></p>`
        + '<p style="opacity:.65;font-size:12px">如果尚未启动，请先带开发环境变量启动 DSH。</p></div>'
        + `<script>location.replace(${JSON.stringify(target)});</script>`;
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(html),
      });
      res.end(req.method === 'HEAD' ? undefined : html);
    });
  },
};

const viteServer = await createServer({
  configFile: viteConfigFile,
  plugins: [directAccessRedirectPlugin],
  server: {
    host: '127.0.0.1',
    port: vitePort,
    strictPort: true,
    hmr: { path: '/__dsh_vite_hmr' },
    fs: { allow: [checkout] },
    watch: { usePolling: poll },
  },
});
await viteServer.listen();
const viteOrigin = `http://127.0.0.1:${vitePort}`;

const stamp = () => {
  try {
    const info = statSync(join(ROOT, 'client.js'));
    return `${info.size}@${Math.round(info.mtimeMs)}`;
  } catch {
    return 'none';
  }
};

function touchHostGraph() {
  const now = new Date();
  const touched = ['index.js'];
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (name === 'dev') continue;
        walk(full, `${prefix}/${name}`);
      } else if (name.endsWith('.mjs')) {
        touched.push(`${prefix}/${name}`);
      }
    }
  };
  walk(join(ROOT, 'src'), 'src');
  for (const rel of touched) {
    try { utimesSync(join(ROOT, rel), now, now); } catch { /* ignore */ }
  }
  return touched.length;
}

let clientBuilds = 0;
const esbuild = await esbuildContext({
  absWorkingDir: ROOT,
  entryPoints: ['src/studio/studio-entry.js'],
  outfile: 'client.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  legalComments: 'inline',
  banner: { js: '/* Generated by scripts/dev-live.mjs. OpenFilm portions: MIT, see vendor/LICENSE. */' },
  plugins: [{
    name: 'no996-dev-live-report',
    setup(build) {
      build.onEnd((result) => {
        clientBuilds += 1;
        if (result.errors.length) {
          console.log(`\n[dev-live] client.js build #${clientBuilds} FAILED: ${result.errors[0].text}`);
        } else {
          console.log(`[dev-live] client.js rebuilt #${clientBuilds} (${stamp()})`);
        }
      });
    },
  }],
});
await esbuild.watch();

const watchers = [];
let hostTimer = null;
try {
  const w = watch(join(ROOT, 'src'), { recursive: true, persistent: true }, (_event, file) => {
    if (!file || !String(file).endsWith('.mjs')) return;
    const norm = String(file).replace(/\\/g, '/');
    if (norm.startsWith('dev/')) return;
    if (hostTimer) clearTimeout(hostTimer);
    hostTimer = setTimeout(() => {
      const count = touchHostGraph();
      console.log(`[dev-live] src/${norm} changed -> touched ${count} Host modules (reload plugin in DSH when ready)`);
    }, 120);
  });
  watchers.push(w);
} catch { /* ignore */ }

console.log('');
console.log('==============================================================');
console.log(' No996 Studio / OpenFilm 实时开发模式已启动 (Vite HMR + 热样式)');
console.log('==============================================================');
console.log(` 外部浏览器 / Agent 开放端口 : ${devPortalUrl} (需开启 DSH 开发模式)`);
console.log(` Vite Dev Server (内部 HMR)  : ${viteOrigin} (HMR ws: /__dsh_vite_hmr)`);
console.log(` Upstream Source             : ${checkout}`);
console.log(' Theme CSS                   : assets/theme/*.css + brand/brand.json (原地零刷新替换)');
console.log(' Client Entry                : src/studio/studio-entry.js -> client.js (esbuild watch)');
console.log('');
console.log(' 请使用以下环境变量启动 DSH（启动后无需点面板，上面端口即永久开放）：');
console.log('   $env:NO996_OPENFILM_DEV_HMR = "1"');
console.log(`   $env:NO996_OPENFILM_VITE_ORIGIN = "${viteOrigin}"`);
console.log('   $env:NO996_OPENFILM_DEV = "1"');
console.log('==============================================================');

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (hostTimer) clearTimeout(hostTimer);
  for (const w of watchers) { try { w.close(); } catch { /* ignore */ } }
  await Promise.allSettled([esbuild.dispose(), viteServer.close()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
