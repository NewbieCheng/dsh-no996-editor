/**
 * Shared helpers for OpenFilm built-in library metadata, color-grade LUT SVG
 * generation (matching upstream `gradeFilter`), `:root` / text overrides for
 * `text/text` wordart, and read-only recipe inspection.
 *
 * Pure local helpers: never write project files or perform network calls.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const LOOK_FILTER_ID = 'openfilm-look';
const SAMPLES = 17;
const IDENTITY_MIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

const round = n => Math.round(n * 1000) / 1000;
const clamp = n => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 1));
const lerp = (a, b, k) => a + (b - a) * k;

let cachedLibraryModule;

/** Resolve the pinned `openfilm` server library module (`studio/server/library.mjs`). */
export async function loadBuiltInLibraryModule() {
  if (cachedLibraryModule !== undefined) return cachedLibraryModule;
  try {
    const pkg = dirname(require.resolve('openfilm/package.json'));
    const mod = await import(pathToFileURL(join(pkg, 'studio', 'server', 'library.mjs')).href);
    cachedLibraryModule = typeof mod.libraryIndex === 'function' ? mod : null;
  } catch {
    cachedLibraryModule = null;
  }
  return cachedLibraryModule;
}

/** Resolve built-in library item by `openfilm/<id>` or bare `<id>`, plus index/root when available. */
export async function findLibraryItem(rawId, fallbackItems = null) {
  const id = String(rawId ?? '').trim().replace(/^openfilm\//i, '');
  if (!id) return null;
  const mod = await loadBuiltInLibraryModule();
  if (mod) {
    const index = mod.libraryIndex();
    const item = Array.isArray(index?.items) ? index.items.find(entry => entry?.id === id) : null;
    if (item) return { item, id, builtInRoot: typeof mod.builtInRoot === 'function' ? mod.builtInRoot() : null };
  }
  if (Array.isArray(fallbackItems)) {
    const item = fallbackItems.find(entry => entry?.id === id || entry?.id === `openfilm/${id}`);
    if (item) return { item, id, builtInRoot: null };
  }
  return null;
}

function tableAt(table, x) {
  if (!Array.isArray(table) || table.length === 0) return x;
  if (table.length === 1) return table[0];
  const p = clamp(x) * (table.length - 1);
  const i = Math.min(table.length - 2, Math.floor(p));
  return lerp(table[i], table[i + 1], p - i);
}

function channelCurve(grade, own, amount) {
  return Array.from({ length: SAMPLES }, (_, i) => {
    const x = i / (SAMPLES - 1);
    return round(clamp(lerp(x, tableAt(own, tableAt(grade.all, x)), amount)));
  });
}

const svgData = svg => `data:image/svg+xml,${svg.replace(/[%#<>"]/g, c => encodeURIComponent(c))}`;

/**
 * Generate the exact CSS `url("data:image/svg+xml,...#openfilm-look")` filter function
 * matching upstream `studio/ui/src/lib/grade.ts`.
 */
export function buildGradeFilterCss(id, grade, amount = 1) {
  if (!grade || typeof grade !== 'object') return null;
  const k = clamp(amount);
  const parts = [];
  if (Array.isArray(grade.mix) && grade.mix.length === 12) {
    const m = grade.mix.map((v, i) => round(lerp(IDENTITY_MIX[i], v, k)));
    const rows = [0, 1, 2].map(r => `${m.slice(r * 4, r * 4 + 3).join(' ')} 0 ${m[r * 4 + 3]}`);
    parts.push(`<feColorMatrix type='matrix' values='${rows.join(' ')} 0 0 0 1 0'/>`);
  }
  if (grade.sat != null && grade.sat !== 1) {
    parts.push(`<feColorMatrix type='saturate' values='${round(lerp(1, grade.sat, k))}'/>`);
  }
  if (grade.all || grade.r || grade.g || grade.b) {
    const fn = (c, own) => `<feFunc${c} type='table' tableValues='${channelCurve(grade, own, k).join(' ')}'/>`;
    parts.push(`<feComponentTransfer>${fn('R', grade.r)}${fn('G', grade.g)}${fn('B', grade.b)}</feComponentTransfer>`);
  }
  const cleanId = String(id || '').replace(/^openfilm\//, '');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg'><filter id='${LOOK_FILTER_ID}' x='0' y='0' width='1' height='1' color-interpolation-filters='sRGB' data-look='${cleanId} ${round(k)}'>${parts.join('')}</filter></svg>`;
  return `url("${svgData(svg)}#${LOOK_FILTER_ID}")`;
}

/** Merge `:root` CSS variable overrides on top of existing clip overrides. */
export function mergeRootVars(overrides, vars = {}) {
  const list = Array.isArray(overrides) ? overrides.map(o => structuredClone(o)) : [];
  const entries = Object.entries(vars).filter(([k, v]) => typeof k === 'string' && k.startsWith('--') && v !== undefined && v !== null);
  if (entries.length === 0) return list;
  let rootEntry = list.find(o => o && o.at === ':root');
  if (!rootEntry) {
    rootEntry = { at: ':root', style: {} };
    list.push(rootEntry);
  }
  rootEntry.style = { ...(rootEntry.style || {}), ...Object.fromEntries(entries.map(([k, v]) => [k, String(v)])) };
  return list;
}

/** Set or replace a text override (defaults to `.t` selector used by `text/text`). */
export function mergeTextOverride(overrides, value, selector = '.t') {
  const list = Array.isArray(overrides) ? overrides.map(o => structuredClone(o)) : [];
  if (typeof value !== 'string') return list;
  const idx = list.findIndex(o => o && o.at === selector);
  if (idx >= 0) list[idx] = { ...list[idx], at: selector, text: value };
  else list.push({ at: selector, text: value });
  return list;
}

/** Merge `{ fade: [in, out] }` clip override safely. */
export function mergeFadeOverride(overrides, fade) {
  const list = Array.isArray(overrides) ? overrides.map(o => structuredClone(o)) : [];
  if (!Array.isArray(fade) || fade.length !== 2) return list;
  const cleanFade = [Math.max(0, Number(fade[0]) || 0), Math.max(0, Number(fade[1]) || 0)];
  const idx = list.findIndex(o => o && o.at === undefined);
  if (idx >= 0) list[idx] = { ...list[idx], fade: cleanFade };
  else list.unshift({ fade: cleanFade });
  return list;
}

/** Merge/replace a single CSS declaration (e.g. `filter` or `backdrop-filter`) on a CSS style string. */
export function setStyleDeclaration(styleStr, prop, value) {
  const decls = String(styleStr || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => {
      const idx = part.indexOf(':');
      return idx <= 0 || part.slice(0, idx).trim().toLowerCase() !== prop.toLowerCase();
    });
  if (typeof value === 'string' && value.trim()) decls.push(`${prop}: ${value.trim()}`);
  return decls.join('; ');
}

function readBundleSnippet(builtInRoot, item) {
  if (!builtInRoot || !item?.id) return null;
  const dir = join(builtInRoot, ...item.id.split('/'));
  const savedFile = join(dir, 'saved.json');
  if (!existsSync(savedFile)) return null;
  try {
    const saved = JSON.parse(readFileSync(savedFile, 'utf8'));
    if (saved.kind === 'group' && Array.isArray(saved.clips)) {
      return {
        kind: 'group',
        tracks: [...new Set(saved.clips.map(c => c.track))].length,
        clips: saved.clips.slice(0, 16).map(c => ({
          track: c.track,
          at: c.at,
          src: c.clip?.src,
          duration: Array.isArray(c.clip?.time) ? round((c.clip.time[1] ?? 0) - (c.clip.time[0] ?? 0)) : undefined,
          props: c.clip?.attrs?.['data-props'],
          overrides: c.clip?.overrides,
        })),
      };
    }
    const entryHtml = item.src || saved.path || saved.clip?.src;
    let cssExcerpt = '';
    if (entryHtml) {
      const htmlPath = join(dir, 'files', entryHtml);
      if (existsSync(htmlPath)) {
        const html = readFileSync(htmlPath, 'utf8');
        const styleMatch = /<style[^>]*>([\s\S]{1,1400})/.exec(html);
        if (styleMatch) cssExcerpt = styleMatch[1].replace(/<\/style>[\s\S]*$/, '').trim().slice(0, 1000);
      }
    }
    return {
      kind: saved.kind,
      durationMs: saved.durationMs ?? item.durationMs,
      props: saved.clip?.attrs?.['data-props'],
      keyframes: saved.keyframes ? Object.keys(saved.keyframes) : undefined,
      cssExcerpt: cssExcerpt || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Inspect any OpenFilm built-in library item and return a concise, actionable design & code recipe
 * for both direct `no996_clip` application and creative reference inside custom HTML/Canvas stages.
 */
export function inspectLibraryItem(item, { builtInRoot = null } = {}) {
  const zh = item.name?.['zh-CN'] ?? item.name?.zh;
  const title = item.name?.en ? `${item.name.en}${zh ? ` (${zh})` : ''}` : (zh || item.id);
  const fullId = `openfilm/${item.id}`;
  const lines = [
    `【${title}】`,
    `· ID: ${fullId}  |  分类: ${item.cat} / 类型: ${item.kind}${item.group ? ` / 分组: ${item.group}` : ''}`,
    ...(item.about ? [`· 适用场景: ${item.about}`] : []),
    ...(Array.isArray(item.tags) && item.tags.length ? [`· 标签: ${item.tags.join(', ')}`] : []),
  ];

  if (item.kind === 'textstyle' && item.vars) {
    lines.push('· 供应链路: 纯本地内置花字（零联网）',
      `· CSS 变量配方 (可用于 text/text 组件或直接参考写入 Canvas/HTML):\n${JSON.stringify(item.vars, null, 2)}`,
      `· 直接入轨示例: no996_clip(operations=[{ op: "insert", src: "openfilm/text/text", wordart: "${fullId}", text: "你的大字标题", at: 0, duration: 3, newTrack: 0 }])`);
    return lines.join('\n');
  }

  if (item.kind === 'textmotion' && item.vars) {
    lines.push('· 供应链路: 纯本地内置文字动效（零联网）',
      `· 动效变量配方:\n${JSON.stringify(item.vars, null, 2)}`,
      `· 组合花字示例: no996_clip(operations=[{ op: "insert", src: "openfilm/text/text", wordart: "openfilm/text/looks/gold", textmotion: "${fullId}", text: "标题文字", at: 0, duration: 3 }])`);
    return lines.join('\n');
  }

  if (item.kind === 'look' && item.grade) {
    const summaryGrade = {
      ...(item.grade.sat !== undefined ? { sat: item.grade.sat } : {}),
      ...(item.grade.mix ? { mix: item.grade.mix } : {}),
      curves: ['all', 'r', 'g', 'b'].filter(k => Array.isArray(item.grade[k])),
    };
    lines.push('· 供应链路: 纯本地内置调色滤镜（零联网，17 点 RGB LUT 曲线）',
      `· 调色矩阵摘要:\n${JSON.stringify(summaryGrade, null, 2)}`,
      `· 上轨滤镜层示例: no996_clip(operations=[{ op: "insert", src: "${fullId}", at: 0, duration: 5, amount: 0.85, newTrack: 0 }])`,
      `· 单片段调色示例: no996_clip(operations=[{ op: "preset", clip: "<clipId>", filter: "${fullId}", amount: 0.85 }])`);
    return lines.join('\n');
  }

  if (item.kind === 'motion' && item.motion) {
    lines.push('· 供应链路: 纯本地内置 CSS 关键帧动效/推移（零联网）',
      `· 关键帧定义 (${item.durationMs ?? 0}ms${item.place ? `, place=${item.place}` : ''}):\n${JSON.stringify(item.motion, null, 2)}`,
      `· 套用到现有片段示例: no996_clip(operations=[{ op: "preset", clip: "<clipId>", motion: "${fullId}" }])`);
    return lines.join('\n');
  }

  const bundle = readBundleSnippet(builtInRoot, item);
  if (bundle?.kind === 'group') {
    lines.push(`· 供应链路: 官方多轨结构模板（结构本地${item.music ? `，配乐 ${item.music} 首用需联网缓存` : ''}）`,
      `· 轨道数: ${bundle.tracks}，片段编排:\n${JSON.stringify(bundle.clips, null, 2).slice(0, 2200)}`,
      `· 如需取用为参考或复用素材: no996_library(take="${fullId}")`);
    return lines.join('\n');
  }

  if (item.kind === 'sound' || item.id.startsWith('stickers/emoji/')) {
    lines.push(`· 供应链路: ${item.id.startsWith('sounds/') ? '随包本地音效（零联网）' : '按需联网（首用下载至 ~/.openfilm/library，之后离线复用）'}`);
    if (item.bpm || item.energy) lines.push(`· 节奏参数: ${[item.durationMs ? `${round(item.durationMs / 1000)}s` : null, item.bpm ? `${item.bpm} BPM` : null, item.energy ? `能量 ${item.energy}/5` : null].filter(Boolean).join(' · ')}`);
    lines.push(`· 取用: no996_library(take="${fullId}")`);
    return lines.join('\n');
  }

  lines.push('· 供应链路: 纯本地内置组件包（零联网）');
  if (bundle?.props) lines.push(`· 组件可调参数 (data-props): ${bundle.props}`);
  if (bundle?.cssExcerpt) lines.push(`· 源码样式片段（供设计参考）:\n${bundle.cssExcerpt}`);
  lines.push(`· 放入项目/时间轴: 先 no996_library(take="${fullId}") 或直接 no996_clip(operations=[{ op: "insert", src: "${fullId}", at: 0, duration: ${round((item.durationMs || 3000) / 1000)} }])`);
  return lines.join('\n');
}
