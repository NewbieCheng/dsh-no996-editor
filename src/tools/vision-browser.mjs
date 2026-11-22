// No user URLs or files are served: a dedicated Chromium context intercepts a
// synthetic origin and can read only these pinned runtime/model assets.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveVisionAsset, VISION_WEIGHTS } from '../vision/vision-pack.mjs';

const require = createRequire(import.meta.url);
const origin = 'http://127.0.0.1:58137';
const files = new Map([
  ['/vision_bundle.mjs', 'text/javascript'],
  ['/wasm/vision_wasm_module_internal.js', 'text/javascript'],
  ['/wasm/vision_wasm_module_internal.wasm', 'application/wasm'],
]);
const matteScripts = new Set(['/vision-matting.mjs', '/vision-input-cache.mjs']);
const ortDir = '/vision/ort-1.31.1/';
const ortFiles = new Set(['ort.webgpu.bundle.min.mjs', ...['jsep', 'asyncify', 'jspi'].flatMap(variant => ['mjs', 'wasm'].map(ext => `ort-wasm-simd-threaded.${variant}.${ext}`))]);
const types = file => file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';

async function launchVisionBrowser(signal) {
  const { chromium } = await import('playwright-core');
  let failure;
  for (const channel of [undefined, 'chrome', 'msedge']) {
    signal?.throwIfAborted();
    try {
      return await chromium.launch({ headless: true, ...(channel ? { channel } : {}), timeout: 8000 });
    } catch (error) { failure = error; }
  }
  throw new Error('本地视觉工具无法启动 Chromium；请安装 Chrome / Edge 或配置 Studio 的 Chromium。', { cause: failure });
}

// Runs inside the isolated vision-only page. It receives a bounded, FFmpeg-
// encoded image, not an executable HTML file or a filesystem path.
async function makeTask(model) {
  if (model === 'portrait.onnx') {
    const { matte } = await import('/vision-matting.mjs');
    self.no996Cutout = frame => matte(frame, 1, undefined, true);
    return;
  }
  const { FaceLandmarker, FilesetResolver } = await import('/vision_bundle.mjs');
  const { default: moduleFactory } = await import('/wasm/vision_wasm_module_internal.js');
  const wasm = await FilesetResolver.forVisionTasks(`${location.origin}/wasm`, true);
  self.ModuleFactory = moduleFactory;
  const base = {
    runningMode: 'IMAGE', canvas: new OffscreenCanvas(1, 1),
    baseOptions: { modelAssetPath: `/model/${model}`, delegate: 'CPU' },
  };
  self.no996Vision = await FaceLandmarker.createFromOptions(wasm, { ...base, numFaces: 4 });
}

async function analyzeFrame({ encoded, face }) {
  const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${encoded}`)).blob());
  try {
    if (face) {
      const clamp = n => Math.min(1, Math.max(0, n));
      const round = n => Math.round(clamp(n) * 10000) / 10000;
      const labels = { leftEye: 362, rightEye: 133, nose: 1, mouthLeft: 61, mouthRight: 291 };
      const faces = self.no996Vision.detect(img).faceLandmarks.map(marks => ({
        box: {
          left: round(Math.min(...marks.map(p => p.x))), top: round(Math.min(...marks.map(p => p.y))),
          right: round(Math.max(...marks.map(p => p.x))), bottom: round(Math.max(...marks.map(p => p.y))),
        },
        points: Object.fromEntries(Object.entries(labels).flatMap(([key, i]) => {
          const p = marks[i]; return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? [[key, { x: round(p.x), y: round(p.y) }]] : [];
        })),
      }));
      return { width: img.width, height: img.height, faces };
    }
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const mask = await self.no996Cutout(img);
    const matte = new OffscreenCanvas(mask.w, mask.h);
    const matteCtx = matte.getContext('2d');
    const rgba = matteCtx.createImageData(mask.w, mask.h);
    let visible = 0;
    mask.data.forEach((alpha, i) => {
      rgba.data[i * 4 + 3] = alpha;
      if (alpha >= 128) visible++;
    });
    const foregroundFraction = Math.round(10000 * visible / mask.data.length) / 10000;
    matteCtx.putImageData(rgba, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(matte, 0, 0, img.width, img.height);
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let binary = '';
    for (let i = 0; i < png.length; i += 8192) binary += String.fromCharCode(...png.subarray(i, i + 8192));
    return { png: btoa(binary), width: img.width, height: img.height, foregroundFraction };
  } finally { img.close(); }
}

export async function withVisionBrowser(mode, callback, { signal, launch = launchVisionBrowser, env = process.env, visionPack = null } = {}) {
  signal?.throwIfAborted();
  const model = mode === 'face' ? 'face.task' : 'portrait.onnx';
  const pkgRoot = dirname(require.resolve('openfilm/package.json'));
  const fromStudio = createRequire(join(pkgRoot, 'package.json'));
  const inFaceMode = mode === 'face';
  let runtimeRoot;
  try {
    runtimeRoot = dirname(fromStudio.resolve(inFaceMode ? '@mediapipe/tasks-vision' : 'onnxruntime-web'));
  } catch (error) {
    throw Object.assign(
      new Error(`缺少本地视觉运行时依赖（${inFaceMode ? '@mediapipe/tasks-vision' : 'onnxruntime-web'}），请检查插件安装完整性。`),
      { code: 'VISION_RUNTIME_MISSING', cause: error },
    );
  }
  const spec = VISION_WEIGHTS.find(w => w.id === model);
  const resolved = await resolveVisionAsset(model, { env, openfilmPkgRoot: pkgRoot });
  const data = await readFile(resolved.path);
  if (!spec || createHash('sha256').update(data).digest('hex') !== spec.sha256) {
    throw Object.assign(new Error('本地视觉模型校验失败；请在「设置 → 扩展包」或「存储 → 本地模型」修复或重新安装。'), { code: 'VISION_CHECKSUM_FAILED' });
  }
  const releaseLease = visionPack?.acquireLease?.(model) || (() => {});
  visionPack?.markLoaded?.(model, true);
  signal?.throwIfAborted();
  const browser = await launch(signal);
  const close = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', close, { once: true });
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8">' });
      if (inFaceMode) {
        if (url.pathname === `/model/${model}`) return route.fulfill({ contentType: 'application/octet-stream', body: data });
        const contentType = files.get(url.pathname);
        return contentType ? route.fulfill({ contentType, path: join(runtimeRoot, url.pathname.slice(1)) }) : route.abort();
      }
      if (url.pathname === `/vision/${model}`) return route.fulfill({ contentType: 'application/octet-stream', body: data });
      if (url.pathname === '/vision/models.json') return route.fulfill({ json: { [model]: { ready: true } } });
      if (matteScripts.has(url.pathname)) return route.fulfill({ contentType: 'text/javascript', path: join(pkgRoot, 'src', url.pathname.slice(1)) });
      const ortFile = url.pathname.startsWith(ortDir) ? url.pathname.slice(ortDir.length) : '';
      return ortFiles.has(ortFile) ? route.fulfill({ contentType: types(ortFile), path: join(runtimeRoot, ortFile) }) : route.abort();
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.evaluate(makeTask, model);
    return await callback(async bytes => {
      signal?.throwIfAborted();
      return page.evaluate(analyzeFrame, { encoded: bytes.toString('base64'), face: mode === 'face' });
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', close);
    await browser.close().catch(() => {});
    releaseLease();
  }
}
