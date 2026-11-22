/**
 * Unified Vision Model Store & Pack Installer (`@newbiecheng/no996-models-vision`).
 *
 * Persistent storage lives under `$DSH_HOME/no996-openfilm/model-store/vision/`,
 * separate from `node_modules` and plugin install directories so plugin upgrades,
 * disables, and reinstalls never wipe verified weights.
 *
 * Never triggers background network downloads on startup or probe. Downloads run
 * only on explicit user action, with single-flight locking, stall watchdogs,
 * mirror -> official fallback, strict tar entry whitelisting, and SHA-256
 * verification before publishing the `.ok` readiness mark.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { createStallWatch, DEFAULT_CONNECT_MS, DEFAULT_IDLE_MS, linkSignals, stallReason } from '../host/download-stall.mjs';

const require = createRequire(import.meta.url);

export const VISION_PACK_ID = 'no996-models-vision';
export const VISION_PACK_PACKAGE = '@newbiecheng/no996-models-vision';
export const VISION_PACK_VERSION = '0.2.0';
export const VISION_PACK_TARBALL_BYTES = 15449643;
export const VISION_PACK_UNPACKED_BYTES = 16993554;
export const MAX_TARBALL_DOWNLOAD_BYTES = 48 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 32 * 1024 * 1024;

export const VISION_WEIGHTS = Object.freeze([
  Object.freeze({
    id: 'portrait.onnx',
    archivePath: 'package/models/portrait.onnx',
    bytes: 12984781,
    sha256: '25f165da9bfd30830a575f1f0490f1acd995975cb349bc02f3d79332e1fe5cf6',
    capability: 'cutout',
    label: 'MODNet 人像抠像',
    license: 'Apache-2.0',
  }),
  Object.freeze({
    id: 'face.task',
    archivePath: 'package/models/face.task',
    bytes: 3758596,
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    capability: 'face',
    label: 'MediaPipe 人脸关键点定位',
    license: 'Apache-2.0',
  }),
  Object.freeze({
    id: 'person.tflite',
    archivePath: 'package/models/person.tflite',
    bytes: 250177,
    sha256: '490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e',
    capability: 'person',
    label: 'MediaPipe 人物分割',
    license: 'Apache-2.0',
  }),
]);

export const VISION_MANIFEST_DIGEST = createHash('sha256')
  .update(VISION_WEIGHTS.map(w => `${w.id}:${w.bytes}:${w.sha256}`).join('|'))
  .digest('hex')
  .slice(0, 16);

export const VISION_OFFICIAL_TARBALL_URL =
  `https://registry.npmjs.org/@newbiecheng/no996-models-vision/-/no996-models-vision-${VISION_PACK_VERSION}.tgz`;
export const VISION_CN_MIRROR_TARBALL_URL =
  `https://registry.npmmirror.com/@newbiecheng/no996-models-vision/-/no996-models-vision-${VISION_PACK_VERSION}.tgz`;

export function visionSources(env = process.env) {
  const override = typeof env?.NO996_VISION_PACK_URL === 'string' ? env.NO996_VISION_PACK_URL.trim() : '';
  if (override) return [{ id: 'custom', label: '自定义源', url: override }];
  const mirror = typeof env?.NO996_VISION_MIRROR_URL === 'string' ? env.NO996_VISION_MIRROR_URL.trim() : '';
  const list = [];
  if (mirror) list.push({ id: 'mirror', label: '国内镜像', url: mirror });
  else list.push({ id: 'npmmirror', label: '国内镜像 (npmmirror)', url: VISION_CN_MIRROR_TARBALL_URL });
  list.push({ id: 'npmjs', label: 'npmjs.org 官方源', url: VISION_OFFICIAL_TARBALL_URL });
  return list;
}

export function dshHomeDir({ env = process.env, home = homedir() } = {}) {
  return env?.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(home, '.dsh');
}

export function openfilmHomeDir({ env = process.env, home = homedir() } = {}) {
  return env?.OPENFILM_HOME && env.OPENFILM_HOME.length > 0 ? env.OPENFILM_HOME : join(home, '.openfilm');
}

export function visionStoreRoot({ env = process.env, home = homedir() } = {}) {
  return join(dshHomeDir({ env, home }), 'no996-openfilm', 'model-store', 'vision');
}

export function visionPackDir({ env = process.env, home = homedir(), digest = VISION_MANIFEST_DIGEST } = {}) {
  return join(visionStoreRoot({ env, home }), 'packs', VISION_PACK_ID, digest);
}

export function visionReadyMark({ env = process.env, home = homedir(), digest = VISION_MANIFEST_DIGEST } = {}) {
  return join(visionPackDir({ env, home, digest }), '.ok');
}

export function visionIndexPath({ env = process.env, home = homedir() } = {}) {
  return join(visionStoreRoot({ env, home }), 'index.json');
}

export function legacyUserVisionDir({ env = process.env, home = homedir() } = {}) {
  return join(openfilmHomeDir({ env, home }), 'cache', 'vision', '1');
}

export function legacyBundledVisionDir(openfilmPkgRoot) {
  if (openfilmPkgRoot) return join(openfilmPkgRoot, 'models', 'vision');
  try {
    return join(dirname(require.resolve('openfilm/package.json')), 'models', 'vision');
  } catch {
    return null;
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function verifyWeightFile(filePath, spec) {
  let info;
  try {
    info = await lstat(filePath);
  } catch {
    return { status: 'missing', bytes: 0 };
  }
  if (!info.isFile() || info.isSymbolicLink()) return { status: 'corrupt', bytes: 0, reason: 'not_regular_file' };
  if (info.size !== spec.bytes) return { status: 'incomplete', bytes: info.size, reason: 'size_mismatch' };
  const digest = await sha256File(filePath);
  if (digest !== spec.sha256) return { status: 'corrupt', bytes: info.size, reason: 'sha256_mismatch' };
  return { status: 'valid', bytes: info.size };
}

function verifyWeightSync(filePath, spec) {
  try {
    const info = statSync(filePath);
    if (!info.isFile() || info.size !== spec.bytes) return false;
    const digest = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    return digest === spec.sha256;
  } catch {
    return false;
  }
}

/**
 * Parse a ustar `.tar` buffer safely in pure JavaScript.
 * Rejects symlinks, hardlinks, path traversal (`..`), absolute paths, and non-regular files.
 */
export function extractTarEntries(tarBuffer, { allowedPaths, maxTotalBytes = MAX_UNPACKED_BYTES } = {}) {
  if (!Buffer.isBuffer(tarBuffer)) throw new TypeError('tarBuffer must be a Buffer');
  const allowed = allowedPaths ? new Set(allowedPaths) : null;
  const extracted = new Map();
  let offset = 0;
  let totalBytes = 0;
  let paxPath = null;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(b => b === 0)) break;

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const rawPrefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const typeFlag = String.fromCharCode(header[156] || 48);
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = sizeOctal ? Number.parseInt(sizeOctal, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw Object.assign(new Error('压缩包头大小字段无效'), { code: 'ARCHIVE_CORRUPT' });
    }
    const blocks = Math.ceil(size / 512) * 512;
    if (offset + blocks > tarBuffer.length) {
      throw Object.assign(new Error('压缩包内容截断'), { code: 'ARCHIVE_CORRUPT' });
    }
    const payload = tarBuffer.subarray(offset, offset + size);
    offset += blocks;

    if (typeFlag === 'x') {
      const text = payload.toString('utf8');
      for (const line of text.split('\n')) {
        const m = /^\d+\s+path=(.+)$/.exec(line);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (typeFlag === 'g') continue;

    const entryPath = (paxPath || (rawPrefix ? `${rawPrefix}/${rawName}` : rawName)).replace(/^\.\//, '');
    paxPath = null;

    if (entryPath.startsWith('/') || entryPath.includes('\\') || entryPath.split('/').some(p => p === '..' || p === '.')) {
      throw Object.assign(new Error(`压缩包包含不安全路径：${entryPath}`), { code: 'UNSAFE_ARCHIVE_PATH' });
    }
    if (typeFlag === '1' || typeFlag === '2') {
      throw Object.assign(new Error(`压缩包拒绝包含链接文件：${entryPath}`), { code: 'UNSAFE_ARCHIVE_LINK' });
    }
    if (typeFlag === '5') continue;
    if (typeFlag !== '0' && typeFlag !== '\0') continue;
    if (allowed && !allowed.has(entryPath)) continue;

    totalBytes += size;
    if (totalBytes > maxTotalBytes) {
      throw Object.assign(new Error('压缩包解压体积超出安全上限'), { code: 'ARCHIVE_TOO_LARGE' });
    }
    extracted.set(entryPath, Buffer.from(payload));
  }
  return extracted;
}

/**
 * Probe all three vision runtime libraries lazily (never crashes module import).
 */
export function probeVisionRuntime({ openfilmPkgRoot = null } = {}) {
  const fromRoot = openfilmPkgRoot || (() => {
    try { return dirname(require.resolve('openfilm/package.json')); } catch { return null; }
  })();
  const resolvers = [
    ...(fromRoot ? [createRequire(join(fromRoot, 'package.json'))] : []),
    ...(openfilmPkgRoot ? [] : [require]),
  ];
  const findPkgDir = (resFn, pkg) => {
    try {
      return dirname(resFn.resolve(`${pkg}/package.json`));
    } catch {
      try {
        let dir = dirname(resFn.resolve(pkg));
        while (dir && dirname(dir) !== dir) {
          const cand = join(dir, 'package.json');
          if (existsSync(cand)) {
            const parsed = JSON.parse(readFileSync(cand, 'utf8'));
            if (parsed?.name === pkg) return dir;
          }
          dir = dirname(dir);
        }
      } catch { /* ignore */ }
    }
    return '';
  };
  const check = (pkg) => {
    for (const resFn of resolvers) {
      const dir = findPkgDir(resFn, pkg);
      if (dir) {
        try {
          const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || '';
          return { available: true, version, path: dir };
        } catch {
          return { available: true, version: '', path: dir };
        }
      }
    }
    return { available: false, version: '', path: '' };
  };
  const ort = check('onnxruntime-web');
  const mediapipe = check('@mediapipe/tasks-vision');
  const playwright = check('playwright-core');
  const missing = [];
  if (!ort.available) missing.push('onnxruntime-web');
  if (!mediapipe.available) missing.push('@mediapipe/tasks-vision');
  const ready = missing.length === 0;
  return {
    ready,
    state: ready ? 'ready' : 'missing_dependency',
    providedByCore: true,
    missing,
    packages: {
      'onnxruntime-web': ort,
      '@mediapipe/tasks-vision': mediapipe,
      'playwright-core': playwright,
    },
  };
}

/**
 * Read-only probe of legacy user cache (`cache/vision/1`) and legacy 0.19.x bundled directory.
 */
export async function probeLegacyVisionWeights({ env = process.env, home = homedir(), openfilmPkgRoot = null } = {}) {
  const candidates = [
    { sourceKind: 'legacy_cache', dir: legacyUserVisionDir({ env, home }) },
    ...(legacyBundledVisionDir(openfilmPkgRoot) ? [{ sourceKind: 'legacy_bundled', dir: legacyBundledVisionDir(openfilmPkgRoot) }] : []),
  ];
  for (const candidate of candidates) {
    if (!candidate.dir || !existsSync(candidate.dir)) continue;
    const matched = [];
    for (const spec of VISION_WEIGHTS) {
      const check = await verifyWeightFile(join(candidate.dir, spec.id), spec);
      if (check.status === 'valid') matched.push(spec.id);
    }
    if (matched.length === VISION_WEIGHTS.length) {
      return { available: true, sourceKind: candidate.sourceKind, dir: candidate.dir, matched };
    }
  }
  return { available: false, sourceKind: '', dir: '', matched: [] };
}

/**
 * Resolve one verified vision weight file without ever making network calls.
 * Checks managed store first, then verified legacy user cache / bundled fallback.
 */
export async function resolveVisionAsset(modelName, { env = process.env, home = homedir(), openfilmPkgRoot = null } = {}) {
  const spec = VISION_WEIGHTS.find(w => w.id === modelName);
  if (!spec) throw Object.assign(new Error(`未知的视觉模型：${modelName}`), { code: 'UNKNOWN_VISION_MODEL' });

  const managedDir = visionPackDir({ env, home });
  const managedFile = join(managedDir, spec.id);
  const markExists = existsSync(visionReadyMark({ env, home }));
  if (markExists) {
    const check = await verifyWeightFile(managedFile, spec);
    if (check.status === 'valid') return { path: managedFile, sourceKind: 'managed', spec };
  }

  for (const dir of [legacyUserVisionDir({ env, home }), legacyBundledVisionDir(openfilmPkgRoot)]) {
    if (!dir) continue;
    const candidate = join(dir, spec.id);
    const check = await verifyWeightFile(candidate, spec);
    if (check.status === 'valid') return { path: candidate, sourceKind: dir === legacyUserVisionDir({ env, home }) ? 'legacy_cache' : 'legacy_bundled', spec };
  }

  const err = new Error(`缺少本地视觉模型 ${spec.id}（请前往「设置 → 扩展包」或「存储 → 本地模型」安装本地视觉组件）。`);
  err.code = 'VISION_MODEL_NOT_INSTALLED';
  err.modelId = spec.id;
  throw err;
}

export function resolveVisionAssetSync(modelName, { env = process.env, home = homedir(), openfilmPkgRoot = null } = {}) {
  const spec = VISION_WEIGHTS.find(w => w.id === modelName);
  if (!spec) return null;
  const managedDir = visionPackDir({ env, home });
  if (existsSync(visionReadyMark({ env, home }))) {
    const f = join(managedDir, spec.id);
    if (verifyWeightSync(f, spec)) return f;
  }
  for (const dir of [legacyUserVisionDir({ env, home }), legacyBundledVisionDir(openfilmPkgRoot)]) {
    if (!dir) continue;
    const f = join(dir, spec.id);
    if (verifyWeightSync(f, spec)) return f;
  }
  return null;
}

export function createVisionPackManager({
  env = process.env,
  home = homedir(),
  openfilmPkgRoot = null,
  fetchImpl = globalThis.fetch,
  logger = null,
  connectMs = DEFAULT_CONNECT_MS,
  idleMs = DEFAULT_IDLE_MS,
} = {}) {
  let revision = 1;
  let activeInstall = null;
  let activeAbort = null;
  let installState = {
    phase: 'idle',
    source: '',
    sourceLabel: '',
    seen: 0,
    total: VISION_PACK_TARBALL_BYTES,
    error: '',
    cancelled: false,
  };
  const activeLeases = new Set();
  const loadedModels = new Set();

  function acquireLease(reason = 'vision') {
    const token = { id: randomUUID(), reason };
    activeLeases.add(token);
    return () => { activeLeases.delete(token); };
  }

  function markLoaded(modelId, loaded = true) {
    if (loaded) loadedModels.add(modelId);
    else loadedModels.delete(modelId);
    revision += 1;
  }

  async function writeManagedStoreFromBuffers(fileBuffers, sourceInfo) {
    const storeRoot = visionStoreRoot({ env, home });
    const targetDir = visionPackDir({ env, home });
    const stagingDir = join(storeRoot, 'staging', randomUUID());
    await mkdir(stagingDir, { recursive: true });
    try {
      for (const spec of VISION_WEIGHTS) {
        const buf = fileBuffers.get(spec.id);
        if (!Buffer.isBuffer(buf) || buf.length !== spec.bytes) {
          throw Object.assign(new Error(`视觉权重大小异常：${spec.id}`), { code: 'VISION_CHECKSUM_FAILED' });
        }
        const digest = createHash('sha256').update(buf).digest('hex');
        if (digest !== spec.sha256) {
          throw Object.assign(new Error(`视觉权重 SHA-256 校验失败：${spec.id}`), { code: 'VISION_CHECKSUM_FAILED' });
        }
        await writeFile(join(stagingDir, spec.id), buf);
      }
      await writeFile(join(stagingDir, 'manifest.json'), JSON.stringify({
        schemaVersion: 1,
        packId: VISION_PACK_ID,
        packVersion: VISION_PACK_VERSION,
        packageName: VISION_PACK_PACKAGE,
        digest: VISION_MANIFEST_DIGEST,
        source: sourceInfo,
        installedAt: new Date().toISOString(),
        models: VISION_WEIGHTS,
      }, null, 2) + '\n', 'utf8');
      await writeFile(join(stagingDir, '.ok'), `${VISION_MANIFEST_DIGEST}\n`, 'utf8');

      await mkdir(dirname(targetDir), { recursive: true });
      await rm(targetDir, { recursive: true, force: true });
      await rename(stagingDir, targetDir);

      await writeFile(visionIndexPath({ env, home }), JSON.stringify({
        schemaVersion: 1,
        activePack: VISION_PACK_ID,
        version: VISION_PACK_VERSION,
        digest: VISION_MANIFEST_DIGEST,
        dir: targetDir,
        source: sourceInfo,
        updatedAt: new Date().toISOString(),
      }, null, 2) + '\n', 'utf8');
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
    revision += 1;
  }

  async function inspectTempResiduals() {
    const storeRoot = visionStoreRoot({ env, home });
    const tmpDir = join(storeRoot, 'tmp');
    let bytes = 0;
    try {
      for (const name of await readdir(tmpDir)) {
        try {
          const info = await lstat(join(tmpDir, name));
          if (info.isFile()) bytes += info.size;
        } catch { /* ignore */ }
      }
    } catch { /* no tmp dir */ }
    return bytes;
  }

  async function status() {
    const packDir = visionPackDir({ env, home });
    const markOk = existsSync(visionReadyMark({ env, home }));
    const runtime = probeVisionRuntime({ openfilmPkgRoot });
    const tempBytes = await inspectTempResiduals();

    const files = [];
    let managedBytes = 0;
    let allManagedValid = markOk;
    for (const spec of VISION_WEIGHTS) {
      const res = await verifyWeightFile(join(packDir, spec.id), spec);
      managedBytes += res.bytes;
      if (res.status !== 'valid') allManagedValid = false;
      files.push({ ...spec, managedStatus: res.status, bytesOnDisk: res.bytes });
    }

    let sourceKind = 'missing';
    let effectiveDir = '';
    if (allManagedValid) {
      sourceKind = 'managed_download';
      effectiveDir = packDir;
    } else {
      const legacy = await probeLegacyVisionWeights({ env, home, openfilmPkgRoot });
      if (legacy.available) {
        sourceKind = legacy.sourceKind;
        effectiveDir = legacy.dir;
      }
    }

    const legacyAvailable = !allManagedValid ? await probeLegacyVisionWeights({ env, home, openfilmPkgRoot }) : { available: false };
    const weightsInstalled = allManagedValid || sourceKind === 'legacy_cache' || sourceKind === 'legacy_bundled';
    const hasCorrupt = files.some(f => f.managedStatus === 'corrupt' || (f.managedStatus === 'incomplete' && !activeInstall));

    let installStateLabel = 'missing';
    if (activeInstall) installStateLabel = installState.phase === 'verifying' ? 'verifying' : 'downloading';
    else if (allManagedValid) installStateLabel = 'installed';
    else if (sourceKind === 'legacy_cache' || sourceKind === 'legacy_bundled') installStateLabel = 'installed';
    else if (hasCorrupt || tempBytes > 0) installStateLabel = hasCorrupt ? 'corrupt' : 'incomplete';
    else if (installState.phase === 'error') installStateLabel = 'error';

    let overallStatus = 'missing';
    if (activeInstall) overallStatus = installState.phase;
    else if (weightsInstalled && runtime.ready) overallStatus = loadedModels.size > 0 ? 'loaded' : 'ready';
    else if (weightsInstalled && !runtime.ready) overallStatus = 'runtime_missing';
    else if (hasCorrupt) overallStatus = 'needs_repair';
    else if (legacyAvailable.available) overallStatus = 'importable';

    const bytesOnDisk = allManagedValid
      ? managedBytes + tempBytes
      : sourceKind === 'legacy_cache' || sourceKind === 'legacy_bundled'
        ? VISION_PACK_UNPACKED_BYTES + managedBytes + tempBytes
        : managedBytes + tempBytes;

    const reclaimableBytes = allManagedValid
      ? (activeLeases.size === 0 ? managedBytes + tempBytes : 0)
      : (managedBytes + tempBytes);

    return {
      revision,
      packId: VISION_PACK_ID,
      packageName: VISION_PACK_PACKAGE,
      version: VISION_PACK_VERSION,
      digest: VISION_MANIFEST_DIGEST,
      storeDir: packDir,
      effectiveDir,
      sourceKind,
      installState: installStateLabel,
      overallStatus,
      weightsInstalled,
      managed: allManagedValid,
      reusableLocal: sourceKind === 'legacy_cache' || sourceKind === 'legacy_bundled',
      canImportLocal: legacyAvailable.available,
      legacySource: legacyAvailable.available ? legacyAvailable : null,
      inUse: activeLeases.size > 0,
      declaredBytes: VISION_PACK_UNPACKED_BYTES,
      downloadBytes: weightsInstalled ? 0 : VISION_PACK_TARBALL_BYTES,
      bytesOnDisk,
      tempBytes,
      reclaimableBytes,
      installing: Boolean(activeInstall),
      install: { ...installState },
      runtime,
      loadedModels: [...loadedModels],
      capabilities: files.map(f => ({
        id: f.id,
        capability: f.capability,
        label: f.label,
        bytes: f.bytes,
        sha256: f.sha256,
        license: f.license,
        ready: (allManagedValid || f.managedStatus === 'valid' || weightsInstalled) && runtime.ready,
        weightsPresent: allManagedValid || f.managedStatus === 'valid' || weightsInstalled,
        loaded: loadedModels.has(f.id),
      })),
    };
  }

  async function preMigrateLegacy() {
    const current = await status();
    if (current.managed) return { migrated: true, alreadyManaged: true, count: 3, total: 3, status: current };
    const legacy = await probeLegacyVisionWeights({ env, home, openfilmPkgRoot });
    if (!legacy.available) return { migrated: false, reason: 'NO_LEGACY_WEIGHTS', count: 0, total: 3, status: current };

    const buffers = new Map();
    for (const spec of VISION_WEIGHTS) {
      const file = join(legacy.dir, spec.id);
      const check = await verifyWeightFile(file, spec);
      if (check.status !== 'valid') {
        return { migrated: false, reason: 'LEGACY_WEIGHT_INVALID', failed: spec.id, count: buffers.size, total: 3, status: current };
      }
      buffers.set(spec.id, await readFileSafe(file));
    }
    await writeManagedStoreFromBuffers(buffers, { kind: legacy.sourceKind, fromDir: legacy.dir });
    logger?.info?.('vision-pack-migrated', { sourceKind: legacy.sourceKind, count: 3 });
    return { migrated: true, alreadyManaged: false, count: 3, total: 3, status: await status() };
  }

  async function importTarballBuffer(tarGzBuffer, sourceInfo = { kind: 'local_tarball' }) {
    installState = { ...installState, phase: 'verifying', error: '', cancelled: false };
    revision += 1;
    let tarBuf;
    try {
      tarBuf = gunzipSync(tarGzBuffer);
    } catch {
      throw Object.assign(new Error('视觉组件包解压失败，文件可能已损坏。'), { code: 'ARCHIVE_CORRUPT' });
    }
    const allowedPaths = VISION_WEIGHTS.map(w => w.archivePath);
    const entries = extractTarEntries(tarBuf, { allowedPaths, maxTotalBytes: MAX_UNPACKED_BYTES });
    const buffers = new Map();
    for (const spec of VISION_WEIGHTS) {
      const buf = entries.get(spec.archivePath);
      if (!buf) {
        throw Object.assign(new Error(`视觉组件包缺少必要模型文件：${spec.id}`), { code: 'ARCHIVE_INCOMPLETE' });
      }
      if (buf.length !== spec.bytes || createHash('sha256').update(buf).digest('hex') !== spec.sha256) {
        throw Object.assign(new Error(`视觉模型校验失败：${spec.id}`), { code: 'VISION_CHECKSUM_FAILED' });
      }
      buffers.set(spec.id, buf);
    }
    await writeManagedStoreFromBuffers(buffers, sourceInfo);
  }

  async function importFromLocalTarball(tgzPath) {
    if (typeof tgzPath !== 'string' || !tgzPath.trim()) {
      throw Object.assign(new Error('请提供本地 .tgz 压缩包路径'), { code: 'INVALID_PATH' });
    }
    const resolved = resolve(tgzPath.trim());
    const info = await stat(resolved);
    if (!info.isFile() || info.size > MAX_TARBALL_DOWNLOAD_BYTES) {
      throw Object.assign(new Error('本地压缩包无效或超过体积限制'), { code: 'INVALID_TARBALL' });
    }
    const gzBuf = await readFileSafe(resolved);
    await importTarballBuffer(gzBuf, { kind: 'local_tarball', fileName: resolved.split(/[\\/]/).pop() || '' });
    return status();
  }

  async function downloadOneSource(source, signal) {
    const tmpDir = join(visionStoreRoot({ env, home }), 'tmp');
    await mkdir(tmpDir, { recursive: true });
    const partPath = join(tmpDir, `vision-${VISION_PACK_VERSION}-${process.pid}-${randomUUID().slice(0, 8)}.tgz.part`);
    const stall = createStallWatch({ connectMs, idleMs });
    const linked = linkSignals(stall.signal, signal);

    installState = {
      phase: 'connecting',
      source: source.id,
      sourceLabel: source.label,
      seen: 0,
      total: VISION_PACK_TARBALL_BYTES,
      error: '',
      cancelled: false,
    };
    revision += 1;

    try {
      const res = await fetchImpl(source.url, { redirect: 'follow', signal: linked });
      if (!res || !res.ok || !res.body) {
        throw Object.assign(new Error(`下载源返回 HTTP ${res?.status ?? '?'} (${source.label})`), { code: 'VISION_DOWNLOAD_HTTP' });
      }
      stall.connected();
      const contentLength = Number(res.headers?.get?.('content-length') || 0);
      installState = {
        ...installState,
        phase: 'downloading',
        total: contentLength > 0 ? contentLength : VISION_PACK_TARBALL_BYTES,
      };

      let seen = 0;
      const body = Readable.fromWeb(res.body);
      body.on('data', chunk => {
        stall.activity();
        seen += chunk.length;
        if (seen > MAX_TARBALL_DOWNLOAD_BYTES) {
          body.destroy(Object.assign(new Error('下载体积超过安全上限'), { code: 'VISION_DOWNLOAD_TOO_LARGE' }));
          return;
        }
        installState = { ...installState, phase: 'downloading', seen };
      });
      const onAbort = () => {
        try { body.destroy(stallReason(stall.signal.reason) || Object.assign(new Error('已取消下载'), { code: 'ABORTED' })); } catch { /* ignore */ }
      };
      if (linked.aborted) onAbort();
      else linked.addEventListener('abort', onAbort, { once: true });

      try {
        await pipeline(body, createWriteStream(partPath));
      } finally {
        linked.removeEventListener?.('abort', onAbort);
      }

      if (signal?.aborted) throw Object.assign(new Error('已取消下载'), { code: 'ABORTED' });
      const gzBuf = await readFileSafe(partPath);
      await importTarballBuffer(gzBuf, { kind: 'npm_tarball', source: source.id, url: source.url });
    } catch (error) {
      const stalled = stallReason(error) || (error?.name === 'AbortError' ? stallReason(error.cause) : null);
      if (stalled) throw stalled;
      if (signal?.aborted || error?.code === 'ABORTED') {
        throw Object.assign(new Error('已取消下载'), { code: 'ABORTED' });
      }
      throw error;
    } finally {
      stall.clear();
      await unlink(partPath).catch(() => {});
    }
  }

  function startInstall({ force = false } = {}) {
    if (activeInstall) return activeInstall;
    const controller = new AbortController();
    activeAbort = controller;

    activeInstall = (async () => {
      try {
        if (!force) {
          const cur = await status();
          if (cur.managed) return cur;
          if (cur.reusableLocal) {
            const migrated = await preMigrateLegacy();
            if (migrated.migrated) return migrated.status;
          }
        }
        const sources = visionSources(env);
        const failures = [];
        let succeeded = false;
        for (const source of sources) {
          if (controller.signal.aborted) {
            throw Object.assign(new Error('已取消下载'), { code: 'ABORTED' });
          }
          try {
            await downloadOneSource(source, controller.signal);
            succeeded = true;
            break;
          } catch (error) {
            if (controller.signal.aborted || error?.code === 'ABORTED') {
              throw Object.assign(new Error('已取消下载'), { code: 'ABORTED' });
            }
            failures.push(`${source.label}: ${String(error?.message || error).slice(0, 120)}`);
            logger?.warn?.('vision-pack-source-failed', { source: source.id, message: String(error?.message || error).slice(0, 120) });
          }
        }
        if (!succeeded) {
          throw Object.assign(new Error(`所有来源均下载失败（${failures.join('；')}）`), { code: 'VISION_DOWNLOAD_FAILED' });
        }
        installState = { ...installState, phase: 'done', error: '', cancelled: false };
        revision += 1;
        return await status();
      } catch (error) {
        const cancelled = controller.signal.aborted || error?.code === 'ABORTED';
        installState = {
          ...installState,
          phase: cancelled ? 'idle' : 'error',
          cancelled,
          error: cancelled ? '' : String(error?.message || error).slice(0, 300),
        };
        revision += 1;
        throw error;
      } finally {
        activeInstall = null;
        activeAbort = null;
      }
    })();
    activeInstall.catch(() => {});
    return activeInstall;
  }

  async function cancelInstall() {
    if (activeAbort) {
      installState = { ...installState, cancelled: true, phase: 'idle', error: '' };
      activeAbort.abort(Object.assign(new Error('已取消下载'), { code: 'ABORTED' }));
      try { await activeInstall; } catch { /* expected abort */ }
    }
    const tmpDir = join(visionStoreRoot({ env, home }), 'tmp');
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    revision += 1;
    return status();
  }

  async function remove({ cleanResidualsOnly = false } = {}) {
    if (activeInstall) await cancelInstall();
    if (!cleanResidualsOnly && activeLeases.size > 0) {
      throw Object.assign(new Error('本地视觉模型正在被预览、导出或抠像任务使用，请先等待任务结束或取消后再卸载。'), { code: 'MODEL_IN_USE' });
    }
    const storeRoot = visionStoreRoot({ env, home });
    await rm(join(storeRoot, 'tmp'), { recursive: true, force: true }).catch(() => {});
    await rm(join(storeRoot, 'staging'), { recursive: true, force: true }).catch(() => {});
    if (!cleanResidualsOnly) {
      await rm(visionPackDir({ env, home }), { recursive: true, force: true }).catch(() => {});
      await rm(visionIndexPath({ env, home }), { force: true }).catch(() => {});
      loadedModels.clear();
    }
    installState = { phase: 'idle', source: '', sourceLabel: '', seen: 0, total: VISION_PACK_TARBALL_BYTES, error: '', cancelled: false };
    revision += 1;
    return status();
  }

  return {
    status,
    startInstall,
    cancelInstall,
    remove,
    preMigrateLegacy,
    importFromLocalTarball,
    acquireLease,
    markLoaded,
    resolveAsset: (modelName) => resolveVisionAsset(modelName, { env, home, openfilmPkgRoot }),
  };
}

async function readFileSafe(filePath) {
  const handle = await open(filePath, 'r');
  try {
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}
