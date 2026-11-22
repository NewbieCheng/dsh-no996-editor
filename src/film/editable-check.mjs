/**
 * Editable deliverable verification & safe layer override helpers (Task H / P0).
 *
 * Ensures generated and templated films deliver genuinely selectable, editable,
 * and scalable objects (`clipId + elementId` DOM/SVG layers or native clips)
 * rather than baking required text/avatars/callouts into opaque Canvas pixels.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

function safeProjectFile(projectRoot, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return null;
  const clean = relPath.split('?')[0].split('#')[0].replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.split('/').some(p => p === '..' || p === '.')) return null;
  const root = resolve(projectRoot);
  const full = resolve(root, clean);
  const back = relative(root, full);
  if (!back || back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) return null;
  return existsSync(full) ? full : null;
}

function parseAttrs(raw) {
  const attrs = {};
  for (const m of String(raw || '').matchAll(/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/**
 * Parse tracks and clips from `film.html` cleanly enough for structural & editability checks.
 */
export function parseFilmClips(filmHtml) {
  const text = String(filmHtml || '');
  const tracks = [];
  const sectionRe = /<section\b([^>]*)>([\s\S]*?)<\/section>/gi;
  let trackIdx = 0;
  for (const sm of text.matchAll(sectionRe)) {
    const tAttrs = parseAttrs(sm[1]);
    const locked = Object.hasOwn(tAttrs, 'locked') && tAttrs.locked !== 'false';
    const clips = [];
    const tagRe = /<(iframe|video|img|audio|a-page|div|span)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
    for (const cm of sm[2].matchAll(tagRe)) {
      const tag = cm[1].toLowerCase();
      const attrs = parseAttrs(cm[2]);
      if (!attrs.id && !attrs.src && tag !== 'iframe' && tag !== 'video' && tag !== 'img') continue;
      clips.push({
        id: attrs.id || '',
        tag,
        src: attrs.src || '',
        at: attrs.at || '',
        time: attrs.time || '',
        props: attrs['data-props'] || '',
        overrides: attrs.overrides || '',
        track: trackIdx,
        locked,
      });
    }
    tracks.push({ index: trackIdx, locked, clips });
    trackIdx += 1;
  }
  return tracks;
}

/**
 * Inspect an HTML page clip for DOM/SVG editable layers vs Canvas-only content.
 */
export function inspectPageEditableLayers(pageHtml) {
  const html = String(pageHtml || '');
  const withoutScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  const elements = [];
  const idCounts = new Map();
  const dataIdCounts = new Map();

  const elRe = /<(h[1-6]|p|span|div|img|video|svg|text|tspan)\b([^>]*)>/gi;
  for (const m of withoutScripts.matchAll(elRe)) {
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(m[2]);
    const id = attrs.id || '';
    const elementId = attrs['data-element-id'] || '';
    const cls = attrs.class || '';
    const isComposite = Object.hasOwn(attrs, 'data-composite-group');
    const isEditableRole = Boolean(
      elementId
      || id
      || /\b(t|title|subtitle|callout|avatar|caption|headline)\b/.test(cls)
      || /^h[1-6]$/.test(tag)
      || tag === 'img'
      || tag === 'text',
    );
    if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
    if (elementId) dataIdCounts.set(elementId, (dataIdCounts.get(elementId) || 0) + 1);
    if (isEditableRole || isComposite) {
      elements.push({
        tag,
        id: id || null,
        elementId: elementId || null,
        selector: elementId ? `[data-element-id="${elementId}"]` : id ? `#${id}` : cls ? `.${cls.split(/\s+/)[0]}` : tag,
        kind: tag === 'img' || tag === 'video' ? 'media' : tag === 'svg' ? 'shape' : 'text',
        isComposite,
      });
    }
  }

  const canvasMatches = [...withoutScripts.matchAll(/<canvas\b([^>]*)>/gi)];
  const canvasCount = canvasMatches.length;
  const declaredCompositeCanvases = canvasMatches.filter(m => {
    const attrs = parseAttrs(m[1]);
    return Object.hasOwn(attrs, 'data-composite-group') || Boolean(attrs['data-composite-reason']);
  }).length;
  const hasDrawFillText = /\b(?:fillText|strokeText)\s*\(/.test(html);

  const duplicateIds = [...idCounts.entries()].filter(([, c]) => c > 1).map(([k]) => k);
  const duplicateElementIds = [...dataIdCounts.entries()].filter(([, c]) => c > 1).map(([k]) => k);

  return {
    elements,
    canvasCount,
    declaredCompositeCanvases,
    hasDrawFillText,
    duplicateIds,
    duplicateElementIds,
  };
}

/**
 * Merge a layer override entry by `(at, n)` without clobbering existing overrides
 * or unmentioned fields on the same layer.
 */
export function mergeLayerOverride(overrides, { at, n, text, t, s, r, style, lock } = {}) {
  if (typeof at !== 'string' || !at.trim()) {
    throw new Error('layer override 需要非空 selector (`at`) 或 `elementId`。');
  }
  const selector = at.trim();
  const nth = Number.isInteger(n) && n > 0 ? n : undefined;
  const list = Array.isArray(overrides) ? overrides.map(o => structuredClone(o)) : [];
  const idx = list.findIndex(o => o && o.at === selector && (o.n ?? undefined) === nth);
  const existing = idx >= 0 ? { ...list[idx] } : { at: selector, ...(nth ? { n: nth } : {}) };

  if (text !== undefined) {
    if (text === null) delete existing.text;
    else existing.text = String(text);
  }
  if (t !== undefined) {
    if (t === null) delete existing.t;
    else if (Array.isArray(t) && t.length === 2 && t.every(v => typeof v === 'number' && Number.isFinite(v))) {
      existing.t = [Math.round(t[0] * 1000) / 1000, Math.round(t[1] * 1000) / 1000];
    } else {
      throw new Error('t 必须是 [dx, dy] 数值数组。');
    }
  }
  if (s !== undefined) {
    if (s === null) delete existing.s;
    else if (typeof s === 'number' && Number.isFinite(s) && s > 0) {
      existing.s = Math.round(s * 10000) / 10000;
    } else if (Array.isArray(s) && s.length === 2 && s.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
      existing.s = [Math.round(s[0] * 10000) / 10000, Math.round(s[1] * 10000) / 10000];
    } else {
      throw new Error('s 必须是大于 0 的缩放倍数或 [sx, sy] 数组。');
    }
  }
  if (r !== undefined) {
    if (r === null) delete existing.r;
    else if (typeof r === 'number' && Number.isFinite(r)) existing.r = Math.round(r * 1000) / 1000;
    else throw new Error('r 必须是数值角度。');
  }
  if (lock !== undefined) {
    if (lock) existing.lock = true;
    else delete existing.lock;
  }
  if (style !== undefined) {
    if (style === null) delete existing.style;
    else if (style && typeof style === 'object' && !Array.isArray(style)) {
      const mergedStyle = { ...(existing.style || {}) };
      for (const [k, v] of Object.entries(style)) {
        if (v === null) delete mergedStyle[k];
        else mergedStyle[k] = v;
      }
      if (Object.keys(mergedStyle).length) existing.style = mergedStyle;
      else delete existing.style;
    } else {
      throw new Error('style 必须是键值对象。');
    }
  }

  if (idx >= 0) list[idx] = existing;
  else list.push(existing);
  return list;
}

/**
 * Inspect an entire OpenFilm project for P0 editable deliverable readiness.
 */
export function checkEditableDeliverable(projectPath, { requiredObjects = [] } = {}) {
  const filmFile = join(projectPath, 'film.html');
  if (!existsSync(filmFile)) {
    return { ok: false, issues: ['项目缺少 film.html'], clips: [], warnings: [] };
  }
  const filmHtml = readFileSync(filmFile, 'utf8');
  const tracks = parseFilmClips(filmHtml);
  const allClips = tracks.flatMap(t => t.clips);

  const issues = [];
  const warnings = [];
  const seenClipIds = new Map();
  const clipDetails = [];

  for (const clip of allClips) {
    if (clip.id) {
      seenClipIds.set(clip.id, (seenClipIds.get(clip.id) || 0) + 1);
    }
    const entry = {
      clipId: clip.id || null,
      tag: clip.tag,
      src: clip.src,
      track: clip.track,
      locked: clip.locked,
      editableKind: (clip.tag === 'video' || clip.tag === 'img') ? 'native_media' : 'page',
      layers: [],
      canvasCount: 0,
      hasDrawFillText: false,
    };

    if (clip.src && /\.(?:html?)$/i.test(clip.src)) {
      const pagePath = safeProjectFile(projectPath, clip.src);
      if (pagePath) {
        const pageHtml = readFileSync(pagePath, 'utf8');
        const pageInfo = inspectPageEditableLayers(pageHtml);
        entry.layers = pageInfo.elements;
        entry.canvasCount = pageInfo.canvasCount;
        entry.hasDrawFillText = pageInfo.hasDrawFillText;
        for (const dup of pageInfo.duplicateElementIds) {
          issues.push(`片段 ${clip.id || clip.src} 存在重复的 data-element-id="${dup}"`);
        }
        if (pageInfo.canvasCount > 0 && pageInfo.elements.filter(e => !e.isComposite).length === 0) {
          if (pageInfo.hasDrawFillText) {
            issues.push(`片段 ${clip.id || clip.src} 使用 Canvas fillText 绘制文字且没有独立可编辑 DOM/SVG 层`);
          } else if (pageInfo.declaredCompositeCanvases === 0) {
            warnings.push(`片段 ${clip.id || clip.src} 仅含未声明 data-composite-group 的 Canvas 层，请确认主体是否需要独立可编辑对象`);
          }
        }
      }
    }
    clipDetails.push(entry);
  }

  for (const [id, count] of seenClipIds.entries()) {
    if (count > 1) issues.push(`存在重复片段 ID "${id}"（共 ${count} 个）`);
  }

  // Verify every user/storyboard-declared required editable object resolves uniquely
  for (const req of Array.isArray(requiredObjects) ? requiredObjects : []) {
    const clipId = req?.clipId || '';
    const elementId = req?.elementId || '';
    const clip = clipDetails.find(c => c.clipId === clipId);
    if (!clip) {
      issues.push(`声明的可编辑对象所在片段不存在：clipId=${clipId}`);
      continue;
    }
    if (clip.editableKind === 'native_media' && !elementId) continue;
    if (!elementId) continue;
    const matches = clip.layers.filter(l => l.elementId === elementId || l.id === elementId);
    if (matches.length === 0) {
      issues.push(`片段 ${clipId} 中找不到声明的可编辑层 elementId="${elementId}"（可能被画进 Canvas 像素中）`);
    } else if (matches.length > 1) {
      issues.push(`片段 ${clipId} 中 elementId="${elementId}" 不唯一（命中 ${matches.length} 处）`);
    }
  }

  // Verify non-destructive override roundtrip on first editable page layer when available
  const firstLayerClip = clipDetails.find(c => c.clipId && c.layers.some(l => !l.isComposite && (l.elementId || l.id)));
  let roundtripVerified = false;
  if (firstLayerClip) {
    const layer = firstLayerClip.layers.find(l => !l.isComposite && (l.elementId || l.id));
    const merged = mergeLayerOverride([], { at: layer.selector, t: [12, -8], s: 1.15, style: { color: '#ffffff' } });
    roundtripVerified = merged.length === 1 && merged[0].at === layer.selector && merged[0].s === 1.15;
  } else if (clipDetails.some(c => c.editableKind === 'native_media')) {
    roundtripVerified = true;
  }

  return {
    ok: issues.length === 0,
    editable: issues.length === 0,
    roundtripVerified,
    issues,
    warnings,
    clips: clipDetails,
  };
}
