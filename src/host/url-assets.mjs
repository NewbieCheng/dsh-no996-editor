/**
 * SSRF-hardened web page image discovery & safe image download helpers for `openfilm_assets`.
 *
 * Security boundaries:
 *   - Only `http:` / `https:` URLs without embedded credentials.
 *   - DNS resolution verified against private/loopback/link-local/CGNAT/reserved IPv4 & IPv6 ranges.
 *   - Redirects (max 4 hops) are manually re-validated before every hop.
 *   - Enforces HTML size <= 2 MiB, image size <= 15 MiB, and strict image magic-byte validation.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 15_000;

const ALLOWED_IMAGE_MIME = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function isBlockedIp(rawIp) {
  const ip = String(rawIp || '').trim().toLowerCase();
  const ver = isIP(ip);
  if (ver === 4) {
    const n = ipv4ToInt(ip);
    if (n === null) return true;
    const inRange = (cidrBase, bits) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(cidrBase) & mask);
    };
    return (
      inRange('0.0.0.0', 8) ||
      inRange('10.0.0.0', 8) ||
      inRange('100.64.0.0', 10) ||
      inRange('127.0.0.0', 8) ||
      inRange('169.254.0.0', 16) ||
      inRange('172.16.0.0', 12) ||
      inRange('192.0.0.0', 24) ||
      inRange('192.0.2.0', 24) ||
      inRange('192.168.0.0', 16) ||
      inRange('198.18.0.0', 15) ||
      inRange('198.51.100.0', 24) ||
      inRange('203.0.113.0', 24) ||
      inRange('224.0.0.0', 4) ||
      inRange('240.0.0.0', 4)
    );
  }
  if (ver === 6) {
    const clean = ip.split('%')[0];
    if (clean === '::' || clean === '::1') return true;
    if (clean.startsWith('::ffff:')) return isBlockedIp(clean.slice('::ffff:'.length));
    const head = Number.parseInt(clean.split(':')[0] || '0', 16);
    if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  return true;
}

export async function assertSafePublicUrl(rawUrl, { lookup = dnsLookup } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('无效的网址格式。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http:// 或 https:// 网页链接。');
  }
  if (parsed.username || parsed.password) {
    throw new Error('链接不允许包含用户名或密码。');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('出于安全限制，不允许访问本机或内网地址。');
  }
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error('出于安全限制，禁止访问内网或保留 IP。');
    return parsed;
  }
  const records = await lookup(host, { all: true }).catch(() => []);
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`无法解析域名：${host}`);
  }
  for (const rec of records) {
    if (isBlockedIp(rec?.address)) {
      throw new Error(`域名 ${host} 解析到受限内网地址，已拒绝访问。`);
    }
  }
  return parsed;
}

async function readBoundedBytes(response, maxBytes, label) {
  const contentLen = Number(response.headers?.get?.('content-length') || 0);
  if (contentLen > maxBytes) {
    throw new Error(`${label} 体积超过限制（>${Math.round(maxBytes / 1024 / 1024)} MB）。`);
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`${label} 体积超过限制。`);
    return new Uint8Array(buf);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(`${label} 体积超过限制（>${Math.round(maxBytes / 1024 / 1024)} MB）。`);
    }
    chunks.push(Buffer.from(value));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function safeFetch(rawUrl, { fetchImpl = globalThis.fetch, lookup = dnsLookup, accept = '*/*', signal } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持 fetch。');
  let currentUrl = (await assertSafePublicUrl(rawUrl, { lookup })).href;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const mergedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImpl(currentUrl, {
      redirect: 'manual',
      signal: mergedSignal,
      headers: {
        accept,
        'user-agent': 'No996Editor/1.0 (+https://github.com/NewbieCheng/dsh-no996-editor)',
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers?.get?.('location');
      if (!loc || hop === MAX_REDIRECTS) throw new Error('网页重定向次数过多或缺少目标地址。');
      const nextUrl = new URL(loc, currentUrl).href;
      currentUrl = (await assertSafePublicUrl(nextUrl, { lookup })).href;
      continue;
    }
    if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）：${currentUrl}`);
    return { response, finalUrl: currentUrl };
  }
  throw new Error('请求失败。');
}

function sniffImageMime(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function attrValue(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  return decodeHtmlEntities(m ? (m[1] ?? m[2] ?? m[3] ?? '') : '');
}

/** Extract page metadata and deduplicated candidate image URLs from a public webpage. */
export async function inspectWebImages(rawUrl, { fetchImpl = globalThis.fetch, lookup = dnsLookup, limit = 12, signal } = {}) {
  const { response, finalUrl } = await safeFetch(rawUrl, {
    fetchImpl,
    lookup,
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    signal,
  });
  const bytes = await readBoundedBytes(response, MAX_HTML_BYTES, '网页正文');
  const html = Buffer.from(bytes).toString('utf8');
  const title = decodeHtmlEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').slice(0, 140);

  let description = '';
  const candidates = [];
  const seen = new Set();
  const pushUrl = (rawSrc, kind, alt = '') => {
    const clean = String(rawSrc || '').trim();
    if (!clean || /^(?:data:|blob:|javascript:|mailto:)/i.test(clean)) return;
    let abs;
    try {
      abs = new URL(clean, finalUrl).href;
    } catch { return; }
    if (!/^https?:\/\//i.test(abs)) return;
    if (/\.(?:svg|ico)(?:[?#]|$)/i.test(abs)) return;
    if (/favicon|sprite|pixel|1x1|blank\./i.test(abs)) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    candidates.push({ url: abs, kind, ...(alt ? { alt: alt.slice(0, 80) } : {}) });
  };

  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const prop = (attrValue(tag, 'property') || attrValue(tag, 'name')).toLowerCase();
    const content = attrValue(tag, 'content');
    if ((prop === 'og:description' || prop === 'description') && content && !description) {
      description = content.slice(0, 220);
    }
    if (prop === 'og:image' || prop === 'og:image:secure_url' || prop === 'twitter:image') {
      pushUrl(content, prop);
    }
  }

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (candidates.length >= limit) break;
    const tag = m[0];
    const w = Number(attrValue(tag, 'width'));
    const h = Number(attrValue(tag, 'height'));
    if ((Number.isFinite(w) && w > 0 && w < 48) || (Number.isFinite(h) && h > 0 && h < 48)) continue;
    const src = attrValue(tag, 'data-src') || attrValue(tag, 'data-original') || attrValue(tag, 'src');
    const alt = attrValue(tag, 'alt');
    pushUrl(src, 'img', alt);
  }

  return {
    finalUrl,
    title,
    description,
    images: candidates.slice(0, limit),
  };
}

/** Securely download a public image URL and verify MIME + binary magic header. */
export async function fetchWebImageBytes(rawUrl, { fetchImpl = globalThis.fetch, lookup = dnsLookup, signal } = {}) {
  const { response, finalUrl } = await safeFetch(rawUrl, {
    fetchImpl,
    lookup,
    accept: 'image/png,image/jpeg,image/webp,image/gif,*/*;q=0.1',
    signal,
  });
  const headerMime = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  const bytes = await readBoundedBytes(response, MAX_IMAGE_BYTES, '图片');
  const sniffed = sniffImageMime(bytes);
  const mediaType = sniffed || (ALLOWED_IMAGE_MIME.has(headerMime) ? headerMime : null);
  if (!mediaType || !ALLOWED_IMAGE_MIME.has(mediaType) || !sniffed) {
    throw new Error('链接返回的不是受支持的 PNG/JPG/WebP/GIF 图片。');
  }
  const ext = ALLOWED_IMAGE_MIME.get(mediaType);
  let baseName = 'web-image';
  try {
    const seg = new URL(finalUrl).pathname.split('/').filter(Boolean).at(-1) || '';
    const cleaned = seg.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48);
    if (cleaned) baseName = cleaned;
  } catch { /* fallback */ }
  return {
    finalUrl,
    bytes,
    mediaType,
    suggestedName: `${baseName}${ext}`,
  };
}
