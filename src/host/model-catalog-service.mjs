/**
 * Unified Host Model Catalog & Storage Ledger.
 *
 * Aggregates all local models (No996 Vision Pack, Vision Runtime, SenseVoice ASR,
 * and OpenFilm library/cache models) under one normalized snapshot with:
 *  - physical-file-identity deduplication (`dev:ino` + canonical realpath);
 *  - partial-read error surfacing (never faking 0 on permission error);
 *  - shared-runtime reference counting for reclaimable byte calculation;
 *  - active model lease checks (`MODEL_IN_USE`) before deletion;
 *  - exact byte reconciliation against OpenFilm Studio's `places.app`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { lstat, readdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { libraryCacheRoot, SENSE_VOICE, senseVoiceDir, senseVoiceReadyMark } from '../asr/asr-models.mjs';
import { loadSherpa } from '../asr/asr-sensevoice.mjs';
import { resolveFfmpeg } from '../asr/asr-audio.mjs';
import {
  dshHomeDir,
  legacyUserVisionDir,
  openfilmHomeDir,
  VISION_PACK_ID,
  VISION_PACK_VERSION,
  VISION_WEIGHTS,
} from '../vision/vision-pack.mjs';

const UPSTREAM_VISION_EXTRAS = Object.freeze([
  { id: 'subject.onnx', label: 'BiRefNet Lite (OpenFilm 缓存)', category: 'cutout', bytes: 98484532, sha256: 'eff9216bb2f9d3f023d9c2b7196845a7485739ab1f231593633e4d2344ffc516', license: 'MIT', usedBy: ['OpenFilm 精精细主体抠像'] },
  { id: 'refine.onnx', label: 'ViTMatte Small (OpenFilm 缓存)', category: 'cutout', bytes: 103885865, sha256: 'bf28d2e0be2c073286e88d60ad649d7123da2749a2d99133fd1098d5887e0225', license: 'Apache-2.0', usedBy: ['OpenFilm 边缘细化'] },
  { id: 'face-parse.onnx', label: 'BiSeNet 人脸解析 (OpenFilm 缓存)', category: 'face', bytes: 53205364, sha256: '0d9bd318e46987c3bdbfacae9e2c0f461cae1c6ac6ea6d43bbe541a91727e33f', license: 'MIT', usedBy: ['OpenFilm 语义美颜'] },
]);

const UPSTREAM_LIBRARY_META = Object.freeze({
  'whisper-small': { label: 'Whisper Small', category: 'asr', license: 'MIT', usedBy: ['OpenFilm 本地转写'] },
  'whisper-large-v3-turbo': { label: 'Whisper Large v3 Turbo', category: 'asr', license: 'MIT', usedBy: ['OpenFilm 本地转写'] },
  'birefnet-lite': { label: 'BiRefNet Lite (库缓存)', category: 'cutout', license: 'MIT', usedBy: ['OpenFilm 本地抠像'] },
});

function isInside(rootDir, targetPath) {
  const rel = relative(resolve(rootDir), resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function diskInfo(targetPath) {
  let probe = resolve(targetPath);
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const root = parse(probe).root || probe;
  try {
    const s = statfsSync(probe);
    return { diskRoot: root, diskFreeBytes: s.bavail * s.bsize };
  } catch {
    return { diskRoot: root, diskFreeBytes: null };
  }
}

async function fileIdentity(filePath) {
  const info = await lstat(filePath, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile()) return null;
  let canonical = filePath;
  try { canonical = await realpath(filePath); } catch { /* keep raw */ }
  const id = info.dev > 0n && info.ino > 0n ? `ino:${info.dev}:${info.ino}` : `path:${canonical}`;
  return { id, bytes: Number(info.size), canonical, mtimeMs: Math.round(Number(info.mtimeMs)) };
}

async function walkDeduplicated(dirs, { excludeRoots = [], warnings = [] } = {}) {
  const seenFiles = new Set();
  const seenDirs = new Set();
  const excluded = excludeRoots.map(r => resolve(r));
  let totalBytes = 0;

  async function walk(dir) {
    let realDir = resolve(dir);
    try {
      const st = await lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return;
      realDir = await realpath(dir);
    } catch (error) {
      if (error?.code !== 'ENOENT') warnings.push({ path: dir, code: error?.code || 'STAT_ERROR' });
      return;
    }
    if (seenDirs.has(realDir)) return;
    if (excluded.some(ex => realDir === ex || realDir.startsWith(ex + sep))) return;
    seenDirs.add(realDir);

    let entries;
    try {
      entries = await readdir(realDir, { withFileTypes: true });
    } catch (error) {
      warnings.push({ path: realDir, code: error?.code || 'READDIR_ERROR' });
      return;
    }

    for (const entry of entries) {
      const full = join(realDir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const ident = await fileIdentity(full);
          if (!ident || seenFiles.has(ident.id)) continue;
          seenFiles.add(ident.id);
          totalBytes += ident.bytes;
        } catch (error) {
          warnings.push({ path: full, code: error?.code || 'STAT_ERROR' });
        }
      }
    }
  }

  for (const dir of dirs) {
    if (dir) await walk(dir);
  }
  return { bytes: totalBytes, seenFiles };
}

function readOpenFilmLibraryJson(openfilmPkgRoot) {
  if (!openfilmPkgRoot) return [];
  try {
    const raw = JSON.parse(readFileSync(join(openfilmPkgRoot, 'library', 'local-models.json'), 'utf8'));
    return Array.isArray(raw?.models) ? raw.models : [];
  } catch {
    return [];
  }
}

export function createModelCatalogService({
  env = process.env,
  home = homedir(),
  openfilmPkgRoot = null,
  visionPack,
  transcribeService,
  preferencesStore = null,
  resolveAsrChoice = null,
  logger = null,
} = {}) {
  let revision = 1;
  let removingSenseVoice = false;

  async function probeSenseVoiceItem() {
    const dir = senseVoiceDir({ env, home });
    const cacheRoot = libraryCacheRoot({ env, home });
    const svStatus = await transcribeService.status().catch(() => ({ ready: false, engine: 'MISSING', bytesOnDisk: 0, installing: false }));
    const okMark = senseVoiceReadyMark({ env, home });
    const disk = diskInfo(dir);
    let tempBytes = 0;
    let presentBytes = 0;
    let corrupt = false;
    const warnings = [];

    for (const file of SENSE_VOICE.files) {
      const target = join(dir, file.name);
      try {
        const ident = await fileIdentity(target);
        if (ident) {
          presentBytes += ident.bytes;
          if (ident.bytes !== file.bytes) corrupt = true;
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') warnings.push({ path: target, code: err?.code || 'STAT_ERROR' });
      }
      const part = `${target}.part`;
      try {
        const partIdent = await fileIdentity(part);
        if (partIdent) tempBytes += partIdent.bytes;
      } catch { /* absent */ }
    }
    try {
      const okIdent = await fileIdentity(okMark);
      if (okIdent) presentBytes += okIdent.bytes;
    } catch { /* absent */ }

    let ffmpegOk = false;
    try { await resolveFfmpeg(); ffmpegOk = true; } catch { ffmpegOk = false; }
    let sherpaOk = false;
    try { loadSherpa(); sherpaOk = true; } catch { sherpaOk = false; }

    const runtimeState = !sherpaOk || !ffmpegOk ? 'missing_dependency' : 'ready';
    const installState = svStatus.installing
      ? 'downloading'
      : svStatus.ready
        ? 'installed'
        : corrupt
          ? 'corrupt'
          : (presentBytes + tempBytes > 0 ? 'incomplete' : 'missing');

    const resolvedAsr = resolveAsrChoice ? await resolveAsrChoice().catch(() => null) : null;
    const isEnabled = svStatus.ready && runtimeState === 'ready' && resolvedAsr?.effective === 'local:sensevoice-small';

    const enabledState = !svStatus.ready || runtimeState !== 'ready'
      ? (resolvedAsr?.configured === 'local:sensevoice-small' ? 'unavailable' : (svStatus.ready ? 'unavailable' : 'available'))
      : isEnabled
        ? 'enabled'
        : 'installed_unused';

    return {
      id: SENSE_VOICE.id,
      version: '1',
      label: 'SenseVoice-small (int8)',
      category: 'asr',
      sourceKind: 'managed_download',
      sourceLabel: '工作台自管下载 (HuggingFace / 镜像)',
      installState,
      runtimeState,
      missingDependencies: [
        ...(!sherpaOk ? ['sherpa-onnx-node'] : []),
        ...(!ffmpegOk ? ['ffmpeg'] : []),
      ],
      enabledState,
      declaredBytes: SENSE_VOICE.bytes,
      downloadBytes: svStatus.ready ? 0 : SENSE_VOICE.bytes,
      bytesOnDisk: presentBytes + tempBytes,
      tempBytes,
      reclaimableBytes: presentBytes + tempBytes,
      dir,
      cacheRoot,
      ...disk,
      usedBy: ['对话输入框语音听写', '素材转写与字幕', '原生剪辑 Agent (no996_transcribe)'],
      canDelete: !svStatus.installing && (presentBytes + tempBytes > 0),
      canCleanResiduals: !svStatus.installing && !svStatus.ready && (presentBytes + tempBytes > 0),
      deleteBlockedReason: svStatus.installing ? '正在下载中，请先取消' : '',
      installing: Boolean(svStatus.installing),
      progress: svStatus.progress ?? 0,
      phase: svStatus.phase || 'idle',
      error: svStatus.error || '',
      warnings,
      inHome: isInside(openfilmHomeDir({ env, home }), dir) || isInside(env?.OPENFILM_SHARED_HOME || openfilmHomeDir({ env, home }), dir),
    };
  }

  async function probeUpstreamLibraryModels() {
    const cacheRoot = libraryCacheRoot({ env, home });
    const modelsJson = readOpenFilmLibraryJson(openfilmPkgRoot);
    const results = [];
    const refCounts = new Map();

    // Pre-scan which files exist for ref counting shared runtime entries
    const modelEntries = modelsJson.filter(m => m && m.id && UPSTREAM_LIBRARY_META[m.id]);
    const fileStatusByModel = new Map();
    for (const m of modelEntries) {
      const files = Array.isArray(m.files) ? m.files : [];
      const digest = createHash('sha256').update(files.map(f => f.sha256 || '').join('')).digest('hex').slice(0, 12);
      const okPath = join(cacheRoot, 'models', `${m.id}.${digest}.ok`);
      const offPath = join(cacheRoot, 'models', `${m.id}.off`);
      const okExists = existsSync(okPath);
      const offExists = existsSync(offPath);
      const presentPaths = new Set();
      let ownBytes = 0;
      let tempBytes = 0;
      let declaredBytes = 0;
      for (const f of files) {
        declaredBytes += Number(f.bytes) || 0;
        const full = join(cacheRoot, ...String(f.path || '').split('/'));
        try {
          const ident = await fileIdentity(full);
          if (ident) {
            presentPaths.add(f.path);
            ownBytes += ident.bytes;
            refCounts.set(f.path, (refCounts.get(f.path) || 0) + 1);
          }
        } catch { /* absent */ }
        // Check .part-* residuals
        try {
          const dir = dirname(full);
          const base = full.split(/[\\/]/).pop();
          for (const name of await readdir(dir)) {
            if (name.startsWith(`${base}.part`)) {
              const partIdent = await fileIdentity(join(dir, name)).catch(() => null);
              if (partIdent) tempBytes += partIdent.bytes;
            }
          }
        } catch { /* absent */ }
      }
      fileStatusByModel.set(m.id, { files, okExists, offExists, presentPaths, ownBytes, tempBytes, declaredBytes });
    }

    for (const m of modelEntries) {
      const meta = UPSTREAM_LIBRARY_META[m.id];
      const info = fileStatusByModel.get(m.id);
      const installed = info.okExists && info.presentPaths.size === info.files.length;
      let uniqueReclaimable = info.tempBytes;
      for (const f of info.files) {
        if (!info.presentPaths.has(f.path)) continue;
        if ((refCounts.get(f.path) || 0) <= 1) {
          uniqueReclaimable += Number(f.bytes) || 0;
        }
      }
      const disk = diskInfo(cacheRoot);
      const hasResiduals = !installed && (info.ownBytes + info.tempBytes > 0);
      results.push({
        id: m.id,
        version: '1',
        label: meta.label,
        category: meta.category,
        sourceKind: 'external_shared',
        sourceLabel: 'OpenFilm 库缓存 (由 OpenFilm 本地服务管理)',
        installState: installed ? 'installed' : hasResiduals ? 'incomplete' : 'missing',
        runtimeState: meta.category === 'asr' ? 'unsupported' : 'ready',
        enabledState: installed ? (info.offExists ? 'installed_unused' : 'enabled') : 'available',
        declaredBytes: info.declaredBytes,
        downloadBytes: installed ? 0 : info.declaredBytes,
        bytesOnDisk: info.ownBytes + info.tempBytes,
        tempBytes: info.tempBytes,
        reclaimableBytes: uniqueReclaimable,
        sharedDeps: info.files.filter(f => (refCounts.get(f.path) || 0) > 1).map(f => f.path),
        dir: join(cacheRoot, 'models', m.id),
        cacheRoot,
        ...disk,
        usedBy: meta.usedBy,
        canDelete: false,
        canCleanResiduals: false,
        deleteBlockedReason: '由 OpenFilm 本地服务管理（可在「设置 → 服务 → 本地服务」卸载）',
        inHome: isInside(openfilmHomeDir({ env, home }), cacheRoot) || isInside(env?.OPENFILM_SHARED_HOME || openfilmHomeDir({ env, home }), cacheRoot),
      });
    }
    return results;
  }

  async function probeUpstreamVisionCache() {
    const dir = legacyUserVisionDir({ env, home });
    const disk = diskInfo(dir);
    const items = [];
    for (const extra of UPSTREAM_VISION_EXTRAS) {
      const target = join(dir, extra.id);
      let bytes = 0;
      let valid = false;
      let corrupt = false;
      try {
        const ident = await fileIdentity(target);
        if (ident) {
          bytes = ident.bytes;
          valid = ident.bytes === extra.bytes;
          if (!valid) corrupt = true;
        }
      } catch { /* absent */ }
      items.push({
        id: extra.id,
        version: '1',
        label: extra.label,
        category: extra.category,
        sourceKind: 'external_shared',
        sourceLabel: 'OpenFilm 按需视觉缓存',
        installState: valid ? 'installed' : corrupt ? 'corrupt' : 'missing',
        runtimeState: 'ready',
        enabledState: valid ? 'installed_unused' : 'available',
        declaredBytes: extra.bytes,
        downloadBytes: valid ? 0 : extra.bytes,
        bytesOnDisk: bytes,
        tempBytes: 0,
        reclaimableBytes: 0,
        dir,
        ...disk,
        usedBy: extra.usedBy,
        canDelete: false,
        canCleanResiduals: false,
        deleteBlockedReason: '外部共享按需视觉缓存（只读展示，不代删）',
        inHome: isInside(openfilmHomeDir({ env, home }), dir),
      });
    }
    return items;
  }

  async function snapshot() {
    const [vision, sensevoice, upstreamLib, upstreamVision] = await Promise.all([
      visionPack.status(),
      probeSenseVoiceItem(),
      probeUpstreamLibraryModels(),
      probeUpstreamVisionCache(),
    ]);

    const items = [];

    // 1. Vision Pack (split weights) + each capability entry
    const visionDisk = diskInfo(vision.storeDir);
    const visionSourceLabel = vision.sourceKind === 'legacy_bundled'
      ? '随包携带（旧版 / 开发工作区，不可单删）'
      : vision.sourceKind === 'legacy_cache'
        ? '外部共享缓存（可本地导入复用）'
        : '工作台自管视觉补充包 (@newbiecheng/no996-models-vision)';

    items.push({
      id: VISION_PACK_ID,
      version: VISION_PACK_VERSION,
      label: '本地视觉基础包（抠像 / 分割 / 人脸关键点）',
      category: 'cutout',
      isPack: true,
      sourceKind: vision.sourceKind === 'legacy_bundled'
        ? 'bundled'
        : vision.sourceKind === 'legacy_cache'
          ? 'external_shared'
          : 'managed_download',
      sourceLabel: visionSourceLabel,
      installState: vision.installState,
      runtimeState: vision.runtime.state,
      enabledState: vision.weightsInstalled && vision.runtime.ready
        ? 'enabled'
        : vision.weightsInstalled
          ? 'unavailable'
          : 'available',
      declaredBytes: vision.declaredBytes,
      downloadBytes: vision.downloadBytes,
      bytesOnDisk: vision.bytesOnDisk,
      tempBytes: vision.tempBytes,
      reclaimableBytes: vision.reclaimableBytes,
      dir: vision.effectiveDir || vision.storeDir,
      ...visionDisk,
      usedBy: ['人像抠像预览 (no996_cutout)', '人脸关键点分析 (no996_face_analysis)', '预览人物分割'],
      canDelete: vision.managed && !vision.inUse && !vision.installing,
      canCleanResiduals: !vision.managed && !vision.installing && vision.tempBytes > 0,
      deleteBlockedReason: vision.inUse
        ? '模型正在被预览或抠像任务使用'
        : vision.sourceKind === 'legacy_bundled'
          ? '随包携带，不可单独删除'
          : vision.sourceKind === 'legacy_cache'
            ? '外部共享路径，不代为删除'
            : '',
      inHome: isInside(openfilmHomeDir({ env, home }), vision.effectiveDir || vision.storeDir),
      visionPack: vision,
    });

    // 2. Vision Runtime (Provided by Core)
    items.push({
      id: 'no996-vision-runtime',
      version: vision.runtime.packages['onnxruntime-web']?.version || '1.31.1',
      label: '本地视觉运行时（ONNX Runtime Web + MediaPipe）',
      category: 'other',
      sourceKind: 'bundled',
      sourceLabel: '随核心提供',
      installState: vision.runtime.ready ? 'installed' : 'error',
      runtimeState: vision.runtime.state,
      enabledState: vision.runtime.ready ? 'bundled' : 'unavailable',
      declaredBytes: 0,
      downloadBytes: 0,
      bytesOnDisk: 0,
      tempBytes: 0,
      reclaimableBytes: 0,
      dir: vision.runtime.packages['onnxruntime-web']?.path || '',
      diskRoot: diskInfo(vision.runtime.packages['onnxruntime-web']?.path || dshHomeDir({ env, home })).diskRoot,
      diskFreeBytes: diskInfo(vision.runtime.packages['onnxruntime-web']?.path || dshHomeDir({ env, home })).diskFreeBytes,
      usedBy: ['人像抠像 / 人物分割 / 人脸关键点'],
      canDelete: false,
      canCleanResiduals: false,
      deleteBlockedReason: '随主插件核心提供，不可单独删除',
      inHome: false,
    });

    // 3. SenseVoice
    items.push(sensevoice);

    // 4. OpenFilm library & vision cache models
    items.push(...upstreamLib, ...upstreamVision);

    // Compute exact deduplicated bytes across physical files so overlapping roots never double count
    const inHomeDirs = [];
    const externalDirs = [];
    const openfilmHome = resolve(openfilmHomeDir({ env, home }));
    const sharedHome = resolve(env?.OPENFILM_SHARED_HOME || openfilmHome);
    const cacheRoot = resolve(libraryCacheRoot({ env, home }));
    const visionStore = resolve(vision.storeDir);

    const modelRoots = [
      senseVoiceDir({ env, home }),
      join(cacheRoot, 'models'),
      legacyUserVisionDir({ env, home }),
      vision.managed ? visionStore : null,
      join(dshHomeDir({ env, home }), 'no996-openfilm', 'model-store', 'vision', 'tmp'),
    ].filter(Boolean);

    for (const r of modelRoots) {
      if (isInside(openfilmHome, r) || isInside(sharedHome, r)) inHomeDirs.push(r);
      else externalDirs.push(r);
    }

    const warnings = [...(sensevoice.warnings || [])];
    const inHomeWalk = await walkDeduplicated(inHomeDirs, { warnings });
    const externalWalk = await walkDeduplicated(externalDirs, { warnings });
    const bgmDir = join(dshHomeDir({ env, home }), 'no996-openfilm', 'media');
    const bgmInHome = isInside(openfilmHome, bgmDir) || isInside(sharedHome, bgmDir);
    const bgmWalk = await walkDeduplicated([bgmDir], { warnings });

    const totalModelsBytes = inHomeWalk.bytes + externalWalk.bytes;
    const totalReclaimableBytes = items.reduce((acc, item) => acc + (item.canDelete || item.canCleanResiduals ? item.reclaimableBytes : 0), 0);

    return {
      revision: revision + (vision.revision || 0),
      partialStats: warnings.length > 0,
      scanWarnings: warnings,
      items,
      vision,
      totals: {
        modelsBytes: totalModelsBytes,
        inHomeModelsBytes: inHomeWalk.bytes,
        externalModelsBytes: externalWalk.bytes,
        resourcesBytes: bgmWalk.bytes,
        inHomeResourcesBytes: bgmInHome ? bgmWalk.bytes : 0,
        reclaimableBytes: totalReclaimableBytes,
      },
    };
  }

  async function reconcileStorage(studioStorage) {
    const snap = await snapshot();
    const rawApp = Number(studioStorage?.places?.app) || 0;
    const inHomeModels = snap.totals.inHomeModelsBytes;
    const inHomeResources = snap.totals.inHomeResourcesBytes;
    // Models and resources inside OpenFilm home are ALREADY included in `places.app` by studio/server/storage.mjs!
    // Subtract them cleanly to avoid double counting, then show breakdown under `工作台自用`.
    const accountedInApp = Math.min(rawApp, inHomeModels + inHomeResources);
    const otherAppBytes = Math.max(0, rawApp - accountedInApp);

    const externalModelsBytes = snap.totals.externalModelsBytes;
    const externalResourcesBytes = snap.totals.resourcesBytes - inHomeResources;

    const effectiveAppTotal = rawApp + externalModelsBytes + externalResourcesBytes;

    return {
      ...(studioStorage || {}),
      places: {
        ...(studioStorage?.places || {}),
        app: effectiveAppTotal,
      },
      no996Breakdown: {
        revision: snap.revision,
        partialStats: snap.partialStats,
        scanWarnings: snap.scanWarnings,
        appTotalBytes: effectiveAppTotal,
        rawStudioAppBytes: rawApp,
        localModelsBytes: snap.totals.modelsBytes,
        inHomeModelsBytes: inHomeModels,
        externalModelsBytes,
        resourcesBytes: snap.totals.resourcesBytes,
        otherAppBytes,
        reclaimableBytes: snap.totals.reclaimableBytes,
        models: snap.items,
        vision: snap.vision,
      },
    };
  }

  async function removeModelById(id, { cleanResidualsOnly = false } = {}) {
    if (id === VISION_PACK_ID) {
      const res = await visionPack.remove({ cleanResidualsOnly });
      revision += 1;
      return { ok: true, id, vision: res, catalog: await snapshot() };
    }
    if (id === SENSE_VOICE.id) {
      if (removingSenseVoice) {
        return { ok: true, id, alreadyRemoving: true, catalog: await snapshot() };
      }
      const sv = await transcribeService.status().catch(() => ({ installing: false }));
      if (sv.installing) {
        throw Object.assign(new Error('SenseVoice 正在下载，请先取消下载或等待完成。'), { code: 'MODEL_IN_USE' });
      }
      if (!cleanResidualsOnly && transcribeService.isBusy?.()) {
        throw Object.assign(new Error('SenseVoice 正在执行转写或听写任务，请先等待完成或取消。'), { code: 'MODEL_IN_USE' });
      }
      removingSenseVoice = true;
      try {
        const dir = senseVoiceDir({ env, home });
        const okMark = senseVoiceReadyMark({ env, home });
        for (const file of SENSE_VOICE.files) {
          await rm(`${join(dir, file.name)}.part`, { force: true }).catch(() => {});
          if (!cleanResidualsOnly) await rm(join(dir, file.name), { force: true }).catch(() => {});
        }
        if (!cleanResidualsOnly) {
          await rm(okMark, { force: true }).catch(() => {});
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          transcribeService.resetRecognizer?.();
        }
        revision += 1;
        return { ok: true, id, catalog: await snapshot() };
      } finally {
        removingSenseVoice = false;
      }
    }
    throw Object.assign(new Error(`该条目不支持由工作台删除：${id}`), { code: 'DELETE_NOT_ALLOWED' });
  }

  return {
    snapshot,
    reconcileStorage,
    removeModelById,
    bumpRevision: () => { revision += 1; },
  };
}
