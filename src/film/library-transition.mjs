// Plan one built-in page transition on a verified, ordinary two-clip cut.
// Studio rebases most operations against a newer revision. A no-op track-layout
// guard uses its native strict revision check and only accepts a plain track.
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function planLibraryTransition({ film, item, clip, before, after, expect }) {
  if (!film || typeof film.rev !== 'string' || film.rev !== expect) throw new Error('影片版本已变化，请重新读取影片后再放置转场。');
  const tracks = film.doc?.tracks;
  if (!Array.isArray(tracks)) throw new Error('影片结构不可读，未放置转场。');
  if (!item || item.cat !== 'transition' || item.place !== 'cut' || item.kind !== 'page' || !finite(item.durationMs) || item.durationMs <= 0) {
    throw new Error('此素材不是可自动放置的内置页面转场，请在 Studio 中应用。');
  }
  const duration = item.durationMs / 1000;
  if (duration > 20) throw new Error('转场时长超过安全范围，请在 Studio 中应用。');
  if (!clip || typeof clip.src !== 'string' || !/^saved\/openfilm\/[^/]+\/.+\.html$/i.test(clip.src) || clip.src.split('/').includes('..')) {
    throw new Error('取用结果不是项目内的转场页面，未放置。');
  }
  let chosen;
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    const clips = Array.isArray(track?.clips) ? track.clips : [];
    const left = clips.find(c => c?.id === before);
    const right = clips.find(c => c?.id === after);
    if (!left || !right) continue;
    if (chosen) throw new Error('片段 ID 不唯一，未放置转场。');
    chosen = { track, clips, left, right, index };
  }
  if (!chosen || before === after) throw new Error('两个片段必须在同一轨道上。');
  const allClips = tracks.flatMap(track => Array.isArray(track?.clips) ? track.clips : []);
  if (allClips.filter(c => c?.id === before).length !== 1 || allClips.filter(c => c?.id === after).length !== 1) {
    throw new Error('片段 ID 不唯一，未放置转场。');
  }
  const { track, clips, left, right, index } = chosen;
  if (track.locked || track.hidden || track.muted || track.captions || Object.keys(track.attrs ?? {}).length) {
    throw new Error('切点所在轨道有锁定或其他设置，无法安全自动放置。');
  }
  if (left.disabled || right.disabled || !Array.isArray(left.time) || left.time.length !== 2 || !Array.isArray(right.time) || right.time.length !== 2) {
    throw new Error('片段禁用或没有明确源时间，无法验证切点。');
  }
  const at = c => finite(c.at) ? c.at : 0;
  const length = c => {
    const speed = c.speed === undefined ? 1 : c.speed;
    if (!finite(speed) || speed <= 0 || !c.time.every(finite) || c.time[1] <= c.time[0]) return NaN;
    return (c.time[1] - c.time[0]) / speed;
  };
  const l = length(left), r = length(right);
  const cut = at(right);
  if (!finite(l) || !finite(r) || Math.abs(at(left) + l - cut) > 0.0015 || l < duration / 2 || r < duration / 2 || cut < duration / 2) {
    throw new Error('切点不相接或相邻片段太短，未放置转场。');
  }
  const ordered = [...clips].sort((a, b) => at(a) - at(b));
  if (ordered.indexOf(right) !== ordered.indexOf(left) + 1) throw new Error('这两个片段不是相邻切点。');
  const ids = clips.map(c => c.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('轨道片段 ID 不完整或不唯一。');
  return {
    cut, duration,
    ops: [
      { op: 'track-layout', at: index, from: [ids], to: [ids] },
      { op: 'insert', clip: { ...clip, time: [0, duration] }, at: Math.round((cut - duration / 2) * 1000) / 1000, newTrack: 0 },
    ],
  };
}
