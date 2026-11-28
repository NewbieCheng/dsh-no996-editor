import { clipSpan, kindOf } from '../../vendor/film-doc.mjs';

const MANAGED = 'no996-project-logo';
const LOCAL_LOGO = /^assets\/brand\/(?:[a-f0-9]{64}\.png|lockup-[a-f0-9]{64}\.html)$/;
const error = code => Object.assign(new Error(code), { code });
const snap = value => Math.round(value * 1000) / 1000;

export function hasBrandLogo(doc) {
  return doc?.tracks?.some(track => track.clips?.some(clip => clip.id === MANAGED && LOCAL_LOGO.test(clip.src))) === true;
}

function logoBox(stage, logo, placement, previous, display) {
  const short = Math.min(stage.w, stage.h);
  const margin = Math.round(short * 0.072);
  const compound = logo.path.endsWith('.html');
  const size = Math.min(short * (compound ? 0.39 : display ? 0.22 : 0.135) / logo.width, short * 0.092 / logo.height);
  const w = previous?.w ?? Math.max(1, Math.round(logo.width * size));
  const h = previous?.h ?? Math.max(1, Math.round(logo.height * size));
  return { x: placement.endsWith('right') ? Math.max(0, stage.w - margin - w) : margin,
    y: placement.startsWith('bottom') ? Math.max(0, stage.h - margin - h) : margin,
    w, h, ...(previous?.r !== undefined ? { r: previous.r } : {}) };
}

function introWindow(doc) {
  let first;
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.id === MANAGED || clip.disabled || kindOf(clip) === 'sound' || !Number.isFinite(clip.at ?? 0)) continue;
      try {
        const span = clipSpan(clip);
        const at = clip.at ?? 0;
        if (span.length >= 0.3 && (!first || at < first.at)) first = { at, length: span.length };
      } catch { /* Unknown duration is not enough to create a logo that may extend the film. */ }
    }
  }
  if (!first) throw error('BRAND_LOGO_NEEDS_PICTURE');
  const lead = first.length > 0.8 ? 0.18 : 0;
  const duration = snap(Math.min(first.length - lead, 2.2));
  return { at: snap(first.at + lead), duration };
}

/** Plan a native still clip on the top track; do not alter any user clip. */
export function brandLogoOps(doc, snapshot, action = 'apply') {
  if (!doc?.stage || !Array.isArray(doc.tracks) || !['apply', 'remove'].includes(action)) throw error('BRAND_INPUT');
  const found = doc.tracks.flatMap(track => track.clips.flatMap(clip => clip.id === MANAGED ? [{ track, clip }] : []));
  if (found.length > 1 || (found[0] && !LOCAL_LOGO.test(found[0].clip.src))) throw error('BRAND_LOGO_CONFLICT');
  const current = found[0];
  if (current?.track.locked) throw error('BRAND_LOGO_LOCKED');
  if (action === 'remove') return current ? [{ op: 'remove', clip: MANAGED }] : [];
  const logo = snapshot?.enabled && snapshot?.mode === 'snapshot' && snapshot.logo;
  if (!logo || !LOCAL_LOGO.test(logo.path) || !Number.isFinite(logo.width) || !Number.isFinite(logo.height) || logo.width <= 0 || logo.height <= 0 ||
    !['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(snapshot.placement)) throw error('BRAND_LOGO_MISSING');
  const previous = current?.clip.box;
  const replaced = current && current.clip.src !== logo.path && (snapshot.display || current.clip.src.endsWith('.html')) &&
    (!previous?.h || Math.abs((previous.w / previous.h) / (logo.width / logo.height) - 1) > 0.1);
  const box = logoBox(doc.stage, logo, snapshot.placement, replaced ? { r: previous?.r } : previous, snapshot.display);
  if (current) {
    const edits = [];
    if (current.clip.src !== logo.path) edits.push({ clip: MANAGED, prop: 'src', value: logo.path });
    const existing = current.clip.box ?? {};
    if (['x', 'y', 'w', 'h', 'r'].some(key => box[key] !== existing[key])) edits.push({ clip: MANAGED, prop: 'box', value: box });
    return edits.length ? [{ op: 'props', edits }] : [];
  }
  const { at, duration } = introWindow(doc);
  return [{ op: 'insert', track: { insert: 0 }, at, clip: { id: MANAGED, src: logo.path, time: [0, duration], box,
    overrides: [{ fade: [Math.min(0.2, duration / 4), Math.min(0.24, duration / 4)] }] } }];
}

export async function applyBrandLogo(transport, projectId, snapshot, action) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const current = await transport.get(base);
  if (typeof current?.rev !== 'string' || !current.rev) throw error('BRAND_LOGO_REVISION');
  const ops = brandLogoOps(current.doc, snapshot, action);
  if (!ops.length) return { changed: false };
  await transport.post(`${base}/edit`, { body: { base: current.rev, ops } });
  return { changed: true };
}
