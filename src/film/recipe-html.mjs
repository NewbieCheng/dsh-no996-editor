// A deliberately small body-HTML sanitizer for template recipes. It keeps
// editable DOM/SVG structure, replaces visible copy with placeholders, and
// never keeps scripts, event handlers, external URLs, or arbitrary CSS.
const TAGS = new Set(['main', 'section', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'strong', 'em', 'i', 'small', 'header', 'footer', 'nav', 'ul', 'ol', 'li', 'br', 'hr', 'img', 'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'pattern', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask']);
const VOID = new Set(['br', 'hr', 'img']);
const ATTRS = new Set(['class', 'id', 'data-element-id', 'style', 'width', 'height', 'src', 'alt', 'role', 'aria-label', 'viewbox', 'preserveaspectratio', 'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'rx', 'ry', 'cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'transform', 'transform-origin', 'gradientunits', 'patternunits', 'offset', 'stop-color', 'stop-opacity', 'clip-path', 'mask']);
const CSS_PROPS = new Set(['color', 'background', 'background-color', 'background-image', 'background-size', 'background-position', 'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-decoration-color', 'text-decoration-thickness', 'text-transform', 'white-space', 'word-break', 'overflow-wrap', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'position', 'top', 'right', 'bottom', 'left', 'inset', 'display', 'flex', 'flex-direction', 'flex-wrap', 'grid', 'grid-template-columns', 'grid-template-rows', 'gap', 'row-gap', 'column-gap', 'align-items', 'align-self', 'justify-content', 'justify-items', 'place-items', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-width', 'border-style', 'border-radius', 'box-shadow', 'opacity', 'overflow', 'overflow-x', 'overflow-y', 'object-fit', 'object-position', 'transform', 'transform-origin', 'writing-mode', 'vertical-align', 'aspect-ratio', 'list-style', 'list-style-type', 'isolation', 'z-index']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const LOCAL_IMAGE = /^(?!\/)(?![A-Za-z][A-Za-z0-9+.-]*:)(?:\.{1,2}\/)?[A-Za-z0-9_@%+.,~()/-]+\.(png|jpe?g|webp|gif)(?:[?#][^\s"<>]*)?$/i;
const bad = message => Object.assign(new Error(message), { code: 'RECIPE_HTML_INPUT' });
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cleanId = value => ID.test(value || '') ? value : '';

function bodyOf(html) {
  const match = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (!match) throw bad('Scene has no body');
  return match[1];
}

function attributes(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    while (/\s/.test(source[i] || '')) i++;
    if (i >= source.length || source[i] === '/') break;
    const start = i;
    while (i < source.length && !/[\s=/>]/.test(source[i])) i++;
    const name = source.slice(start, i).toLowerCase();
    if (!name) break;
    while (/\s/.test(source[i] || '')) i++;
    let value = '';
    if (source[i] === '=') {
      i++;
      while (/\s/.test(source[i] || '')) i++;
      const quote = source[i] === '"' || source[i] === "'" ? source[i++] : '';
      const from = i;
      if (quote) { while (i < source.length && source[i] !== quote) i++; value = source.slice(from, i); if (source[i] === quote) i++; }
      else { while (i < source.length && !/[\s>]/.test(source[i])) i++; value = source.slice(from, i); }
    }
    out.push([name, value]);
  }
  return out;
}

function safeCssValue(name, value, asset) {
  if (value.length > 800 || /[\\<>{}]|expression\s*\(|javascript:|data:text|behavior\s*:|@import/i.test(value)) throw bad('Unsafe CSS value');
  if (/url\s*\(/i.test(value)) {
    if (name !== 'background-image' || !/^url\((['"]?)([^)'"]+)\1\)$/i.test(value.trim())) throw bad('Only local image URLs are allowed');
    const ref = /^url\((['"]?)([^)'"]+)\1\)$/i.exec(value.trim())[2];
    const path = asset(ref);
    return `url("${escape(path)}")`;
  }
  if (name.startsWith('--')) return value.trim();
  return value.trim();
}

function cssDeclarations(source, asset) {
  const kept = [];
  for (const declaration of source.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 1) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    if (!CSS_PROPS.has(name) && !name.startsWith('--')) continue;
    const value = declaration.slice(colon + 1).trim();
    // Embedded SVG/data textures are unnecessary in a portable recipe and may
    // hide external references. Drop only that declaration; keep the layout.
    if (/^data:image\//i.test(value)) continue;
    kept.push(`${name}: ${safeCssValue(name, value, asset)}`);
  }
  return kept.join('; ');
}

function withoutAtRules(css) {
  let out = '', i = 0;
  while (i < css.length) {
    const at = css.indexOf('@', i);
    if (at < 0) return out + css.slice(i);
    out += css.slice(i, at);
    const open = css.indexOf('{', at), semicolon = css.indexOf(';', at);
    if (semicolon >= 0 && (open < 0 || semicolon < open)) { i = semicolon + 1; continue; }
    if (open < 0) return out;
    let depth = 1, j = open + 1;
    for (; j < css.length && depth; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    if (depth) throw bad('Unbalanced stylesheet');
    i = j;
  }
  return out;
}

function safeStyleSheet(source, asset) {
  const css = withoutAtRules(source.replace(/\/\*[\s\S]*?\*\//g, ''));
  if (css.length > 100_000 || /@import|@namespace|expression\s*\(|javascript:/i.test(css)) throw bad('Unsupported stylesheet');
  let out = '', i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const selector = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    for (; j < css.length && depth; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    if (depth) throw bad('Unbalanced stylesheet');
    if (!/^[A-Za-z0-9_#.:[\]="'~*|^$()%,\-+>\s]+$/.test(selector) || selector.includes('@')) throw bad('Unsafe CSS selector');
    const declarations = cssDeclarations(css.slice(open + 1, j - 1), asset);
    if (declarations) out += `${selector}{${declarations}}\n`;
    i = j;
  }
  return out;
}

/** Sanitize one directly referenced local stylesheet for inlining. */
export function sanitizeRecipeCss(css, resolveAsset) {
  if (typeof css !== 'string' || css.length > 200_000) throw bad('Stylesheet is too large');
  return safeStyleSheet(css, ref => {
    const path = resolveAsset(ref);
    if (typeof path !== 'string' || !/^assets\/[A-Za-z0-9_-]+\.(?:png|jpg|webp|gif)$/.test(path)) throw bad('Invalid stylesheet asset');
    return path;
  });
}

/** Returns canonical safe body HTML, placeholder labels and required images. */
export function sanitizeRecipeScene(html, { prefix = 'scene', resolveAsset } = {}) {
  if (typeof html !== 'string' || html.length > 512 * 1024) throw bad('Scene HTML is too large');
  const source = bodyOf(html);
  const assets = new Map();
  const ids = new Set();
  const labels = new Map();
  const stack = [];
  let output = '';
  const asset = ref => {
    if (!LOCAL_IMAGE.test(ref)) throw bad('Only local raster images can be template assets');
    const path = ref.split(/[?#]/)[0];
    const ext = path.split('.').pop().toLowerCase().replace('jpeg', 'jpg');
    if (!IMAGE_EXT.has(ext)) throw bad('Unsupported image type');
    if (assets.has(ref)) return assets.get(ref);
    const target = typeof resolveAsset === 'function' ? resolveAsset(ref) : /^assets\/[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/.test(ref) ? ref : `assets/${prefix}-${assets.size}.${ext}`;
    const valid = typeof resolveAsset === 'function' ? /^assets\/[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/.test(target) : /^assets\/[A-Za-z0-9_-]+\.(?:png|jpg|webp|gif)$/.test(target);
    if (typeof target !== 'string' || !valid) throw bad('Invalid recipe asset path');
    assets.set(ref, target);
    return target;
  };
  const ensureId = (tag, attrs) => {
    if (!['div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'svg', 'g', 'text'].includes(tag)) return;
    let id = cleanId(attrs.get('data-element-id')) || cleanId(attrs.get('id'));
    if (!id) { id = `${prefix}-${ids.size + 1}`; }
    if (ids.has(id)) throw bad(`Duplicate editable id: ${id}`);
    ids.add(id);
    attrs.set('data-element-id', id);
  };
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('<!--', i)) { const end = source.indexOf('-->', i + 4); i = end < 0 ? source.length : end + 3; continue; }
    if (source[i] !== '<') {
      const end = source.indexOf('<', i);
      const raw = source.slice(i, end < 0 ? source.length : end).replace(/\s+/g, ' ').trim();
      i = end < 0 ? source.length : end;
      if (!raw || /^[\s ]+$/.test(raw)) continue;
      const parent = [...stack].reverse().find(item => ['div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'text', 'tspan', 'li'].includes(item.tag));
      if (!parent) throw bad('Visible text has no supported parent');
      const id = parent.attrs.get('data-element-id');
      if (!labels.has(id)) labels.set(id, `${prefix} · 文本 ${labels.size + 1}`);
      output += `{{${id}}}`;
      continue;
    }
    let quote = '', j = i + 1;
    for (; j < source.length; j++) {
      if (quote) { if (source[j] === quote) quote = ''; }
      else if (source[j] === '"' || source[j] === "'") quote = source[j];
      else if (source[j] === '>') break;
    }
    if (j >= source.length) throw bad('Unclosed HTML tag');
    const token = source.slice(i + 1, j);
    i = j + 1;
    if (token.startsWith('!') || token.startsWith('?')) continue;
    const closing = token.startsWith('/');
    const name = (/^\/?\s*([A-Za-z0-9-]+)/.exec(token)?.[1] ?? '').toLowerCase();
    if (!name) continue;
    if (closing) {
      const at = stack.map(item => item.tag).lastIndexOf(name);
      if (at < 0) continue;
      while (stack.length > at) output += `</${stack.pop().tag}>`;
      continue;
    }
    if (name === 'script') { const end = source.toLowerCase().indexOf('</script', i); i = end < 0 ? source.length : end; continue; }
    if (name === 'style') {
      const end = source.toLowerCase().indexOf('</style', i);
      const css = source.slice(i, end < 0 ? source.length : end);
      output += `<style>${safeStyleSheet(css, asset)}</style>`;
      i = end < 0 ? source.length : end;
      continue;
    }
    if (!TAGS.has(name)) continue;
    const attrs = new Map(attributes(token.slice(name.length)));
    for (const key of [...attrs.keys()]) if (!ATTRS.has(key) || key.startsWith('on')) attrs.delete(key);
    ensureId(name, attrs);
    if (name === 'img') {
      const ref = attrs.get('src');
      if (!ref) throw bad('Image layer has no source');
      attrs.set('src', asset(ref));
      attrs.set('alt', attrs.get('alt') ? '模板图片' : '');
    }
    if (attrs.has('style')) attrs.set('style', cssDeclarations(attrs.get('style'), asset));
    const rendered = [...attrs].filter(([, value]) => value !== '').map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
    output += `<${name}${rendered}>`;
    if (!VOID.has(name)) stack.push({ tag: name, attrs });
  }
  while (stack.length) output += `</${stack.pop().tag}>`;
  return { html: output, labels: Object.fromEntries(labels), assets: Object.fromEntries(assets) };
}

/** Imported recipes must already be canonical; no second interpretation. */
export function validateRecipeScene(scene) {
  const canonical = sanitizeRecipeScene(`<body>${scene.html}</body>`, { prefix: scene.id, resolveAsset: ref => scene.assets?.[ref] });
  if (canonical.html !== scene.html) throw bad('Scene HTML is not canonical recipe data');
  for (const [ref, path] of Object.entries(canonical.assets)) if (scene.assets?.[ref] !== path) throw bad('Scene asset map does not match its HTML');
  const keys = Object.keys(scene.labels ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(canonical.labels).sort())) throw bad('Scene placeholders do not match its labels');
  for (const value of Object.values(scene.labels ?? {})) {
    if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw bad('Invalid placeholder label');
  }
  return canonical;
}
