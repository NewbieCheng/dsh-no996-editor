/** Pure DOM/SVG scene composition. User text is always data, never markup. */
export const escapeHtml = value => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function validateSize(size) {
  if (!Array.isArray(size) || size.length !== 2 || size.some(value => !Number.isInteger(value) || value < 16 || value > 8192)) {
    throw new TypeError('Scene size must be two integer dimensions between 16 and 8192');
  }
  return size;
}

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const LOCAL_REF = /^(?![/\\])(?![A-Za-z][A-Za-z0-9+.-]*:)(?!.*[\\\u0000-\u001f])(?:\.{1,2}\/)?[A-Za-z0-9_@%+.,~()/-]+(?:[#?][^\s"<>]*)?$/;
export const localRef = value => {
  const segments = typeof value === 'string' ? value.split(/[?#]/)[0].split('/') : [];
  if (typeof value !== 'string' || !LOCAL_REF.test(value) || segments.slice(1).includes('..') || segments.filter(part => part === '..').length > 1) throw new TypeError(`Unsafe local scene reference: ${value}`);
  return escapeHtml(value);
};

export function elementId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('Editable element IDs must start with a letter and contain only letters, numbers, underscores or hyphens');
  return value;
}

export function textLayer({ id, text, tag = 'p', className = '' } = {}) {
  elementId(id);
  if (!/^[a-z][a-z0-9-]*$/.test(tag) || !/^[A-Za-z0-9_ -]*$/.test(className)) throw new TypeError('Invalid scene layer tag or class');
  return `<${tag} data-element-id="${id}"${className ? ` class="${className}"` : ''}>${escapeHtml(text ?? '')}</${tag}>`;
}

export function subtitleLayer(cues = []) {
  if (!Array.isArray(cues) || cues.length > 500) throw new TypeError('A scene accepts at most 500 subtitle cues');
  const seen = new Set();
  return cues.map((cue, index) => {
    const id = elementId(cue?.id ?? `subtitle-${index + 1}`);
    if (seen.has(id)) throw new TypeError(`Duplicate subtitle id: ${id}`);
    seen.add(id);
    if (!Number.isSafeInteger(cue.fromMs) || !Number.isSafeInteger(cue.toMs) || cue.fromMs < 0 || cue.toMs <= cue.fromMs || cue.toMs > 86_400_000) {
      throw new TypeError('Subtitle cues need increasing non-negative millisecond boundaries');
    }
    if (typeof cue.text !== 'string' || !cue.text.trim()) throw new TypeError('Subtitle text is required');
    return `<p data-element-id="${id}" data-caption="${index}" data-from="${cue.fromMs}" data-to="${cue.toMs}"><span>${escapeHtml(cue.text)}</span></p>`;
  }).join('\n');
}

/** The active cue at an exact time. No wall clock and no previous-frame state. */
export function captionState(cues, timeMs) {
  const t = Number.isFinite(timeMs) ? timeMs : 0;
  return cues.find(cue => t >= cue.fromMs && t < cue.toMs) ?? null;
}

export function safeArea(size, ratio = 0.07) {
  const [w, h] = validateSize(size);
  const padding = Math.round(Math.min(w, h) * Math.max(0, Math.min(0.25, ratio)));
  return { x: padding, y: padding, w: w - padding * 2, h: h - padding * 2 };
}

export function cornerBox(stage, content, placement = 'top-left', marginRatio = 0.07) {
  const [sw, sh] = validateSize(stage);
  const w = Number(content?.w), h = Number(content?.h);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0 || w > sw || h > sh || !['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(placement)) {
    throw new TypeError('Invalid corner box');
  }
  const margin = Math.round(Math.min(sw, sh) * Math.max(0, Math.min(0.25, marginRatio)));
  return { x: placement.endsWith('right') ? sw - margin - w : margin, y: placement.startsWith('bottom') ? sh - margin - h : margin, w, h };
}

export function page({ title, styles = [], style = '', body, script = '', size = [1080, 1920], scripts = [] }) {
  validateSize(size);
  if (!Array.isArray(styles) || !Array.isArray(scripts)) throw new TypeError('Scene assets must be arrays');
  const links = styles.map(href => `<link rel="stylesheet" href="${localRef(href)}">`).join('\n');
  const tags = scripts.map(src => `<script src="${localRef(src)}"></script>`).join('\n');
  const inlineStyle = style.trim() ? `<style>\n${style.trim()}\n</style>\n` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${size[0]}, height=${size[1]}">
<title>${escapeHtml(title ?? '')}</title>
${links}
${tags}${links || tags ? '\n' : ''}${inlineStyle}</head>
<body>
${body}
${script.trim() ? `<script>\n${script.trim()}\n</script>\n` : ''}</body>
</html>
`;
}

/** The static shot wall. Only template-authored local paths are accepted. */
export function shotWall({ title, size = [1080, 1920], shots, audioTracks = [], backdrop = '#1d1b18', sectionTitle, pages = 'pages' } = {}) {
  validateSize(size);
  localRef(pages);
  if (!Array.isArray(shots) || !shots.length || shots.length > 500 || !Array.isArray(audioTracks)) throw new TypeError('Invalid shot wall');
  const frames = shots.map(shot => {
    elementId(shot.id);
    const wallTitle = `${shot.order ?? ''}${shot.order ? ' · ' : ''}${shot.title}`;
    return `    <iframe id="${shot.id}" title="${escapeHtml(wallTitle)}" src="${localRef(pages)}/${elementId(shot.id)}.html#t=0,${seconds(shot.duration)}" at="${fixed(shot.start, 3)}"></iframe>`;
  });
  const trackSections = audioTracks.map(track => {
    elementId(track.id);
    const items = (track.clips ?? []).map(clip => {
      const vol = Number.isFinite(clip.volume) ? ` volume="${seconds(clip.volume)}"` : '';
      const range = Number.isFinite(clip.duration) && clip.duration > 0 ? `#t=0,${seconds(clip.duration)}` : '';
      return `    <audio src="${localRef(clip.src)}${range}" at="${fixed(clip.at, 3)}"${vol}></audio>`;
    });
    const titleAttr = track.title ? ` title="${escapeHtml(track.title)}"` : '';
    return `  <section id="${track.id}"${titleAttr}>\n${items.join('\n')}\n  </section>`;
  });
  const landscape = size[0] > size[1];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${size[0]}, height=${size[1]}">
  <title>${escapeHtml(title)}</title>
  <style>
    /* 本机直开时显示镜头墙；OpenFilm 读取下方 iframe 的 at 与 #t 时间。 */
    body > #shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(${landscape ? 290 : 170}px, 1fr)); gap: ${landscape ? 14 : 12}px; }
    body:has(> #shots) { margin: ${landscape ? 18 : 16}px; background: ${backdrop}; }
    #shots > iframe { display: block; width: 100%; aspect-ratio: ${landscape ? '16 / 9' : '9 / 16'}; height: auto; border: 0; }
  </style>
</head>
<body>
  <section id="shots" title="${escapeHtml(sectionTitle ?? `${title} · ${shots.length} 组`)}">
${frames.join('\n')}
  </section>${trackSections.length ? `\n${trackSections.join('\n')}` : ''}
</body>
</html>
`;
}

const seconds = value => {
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
};
const fixed = (value, digits) => (Math.round(value * 10 ** digits) / 10 ** digits).toFixed(digits);
