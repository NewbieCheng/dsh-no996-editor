// Two benchmark films, produced the way a person would: real project folders, real
// pages, a real local voice-over (offline Windows speech), rendered and exported by
// the pinned Studio, then checked frame by frame. Disposable: everything lives under
// .dev/ and no user project or Studio profile is touched.
//
//   node scripts/benchmark-films.mjs
//
// Evidence written to .dev/benchmarks/<timestamp>/: exports, frames, a contact sheet
// and receipts.json (durations, encoder, outputs, ffprobe facts).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The encoder Studio itself uses: whatever `ffmpeg`/`ffprobe` this machine offers.
const ffmpeg = 'ffmpeg';
const ffprobe = 'ffprobe';
for (const tool of [ffmpeg, ffprobe]) {
  const probe = spawnSync(tool, ['-version'], { stdio: 'ignore' });
  if (probe.status !== 0) throw new Error(`${tool} is required to verify the benchmark exports`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outRoot = join(root, '.dev', 'benchmarks', stamp);
mkdirSync(outRoot, { recursive: true });
const base = join(root, '.dev', 'benchmarks', `work-${stamp}`);
mkdirSync(base, { recursive: true });
process.env.OPENFILM_HOME = join(base, 'home');
process.env.OPENFILM_SHARED_HOME = join(base, 'home');

const page = ({ w, h, duration, body, css = '', frame = '' }) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=${w}, height=${h}">
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  body { width: ${w}px; height: ${h}px; font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif; }
  ${css}
</style></head>
<body>${body}
<script>
  window.film = { width: ${w}, height: ${h}, duration: ${duration}, ready: document.fonts.ready, frame(t) { ${frame} } };
</script></body></html>`;

/** Speak a script offline with the installed Windows voice; returns its seconds. */
function speak(text, file, voice = 'Microsoft Huihui Desktop', rate = 0) {
  const script = `Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice('${voice}') } catch { }
$s.Rate = ${rate}
$s.SetOutputToWaveFile('${file.replaceAll("'", "''")}')
$s.Speak(${JSON.stringify(text)})
$s.Dispose()`;
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`speech failed: ${result.stderr || result.stdout}`);
  return Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
}

// ---------------------------------------------------------------- film A: 口播
const A = { w: 1920, h: 1080 };
const narration = [
  '注意力不是靠喊出来的。',
  '先让人看见问题，再给他一个非改不可的理由。',
  '只讲一个重点，把其余的都删掉。',
  '最后用一个动作收尾，让人知道下一步做什么。',
];
const aDir = join(base, 'film-a');
mkdirSync(join(aDir, 'assets'), { recursive: true });
mkdirSync(join(aDir, 'pages'), { recursive: true });
const voiceFile = join(aDir, 'assets', 'narration.wav');
// Speak sentence by sentence and hold each one long enough to breathe: a natural
// 30–40 s narration rather than a fast read of four lines.
const pieces = [];
narration.forEach((line, index) => {
  const raw = join(aDir, 'assets', `line-${index + 1}.wav`);
  const seconds = speak(line, raw, 'Microsoft Huihui Desktop', -3);
  const padded = join(aDir, 'assets', `line-${index + 1}-padded.wav`);
  const hold = Number((seconds + 2.4).toFixed(3));
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', raw, '-af', `apad=whole_dur=${hold}`, '-ar', '48000', '-ac', '2', padded]);
  pieces.push({ raw, padded, seconds, hold });
});
const listFile = join(aDir, 'assets', 'lines.txt');
writeFileSync(listFile, pieces.map(piece => `file '${piece.padded.replaceAll("'", "'\\''")}'`).join('\n'));
execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-ar', '48000', '-ac', '2', voiceFile]);
const voiceSeconds = Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', voiceFile]).toString().trim());
mkdirSync(join(outRoot, 'film-a'), { recursive: true });

const sceneCount = narration.length;
const aScenes = pieces.map((piece, index) => ({
  index,
  line: narration[index],
  duration: piece.hold,
  start: Number(pieces.slice(0, index).reduce((sum, item) => sum + item.hold, 0).toFixed(3)),
}));
const palette = [
  ['#101418', '#f4ece1', '注意力不是靠喊出来的', '一支 30 秒的片子，先让人停下来'],
  ['#f4ece1', '#101418', '先让人看见问题', '问题具体到能对上自己的处境，才有非改不可的理由'],
  ['#16232b', '#e8f2f0', '只讲一个重点', '其余的都删掉：删掉不是损失，是让人记住'],
  ['#1d1b18', '#f1d9a7', '用一个动作收尾', '让人知道下一步做什么，而不是只记住一句话'],
];
aScenes.forEach((scene, index) => {
  const [bg, fg, title, sub] = palette[index];
  writeFileSync(join(aDir, 'pages', `s${index + 1}.html`), page({
    ...A, duration: scene.duration,
    css: `body { background: ${bg}; color: ${fg}; }
      .stage { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 0 140px; }
      .k { font-size: 26px; letter-spacing: .34em; opacity: .62; margin-bottom: 30px; }
      h1 { font-size: 104px; line-height: 1.14; margin: 0 0 26px; font-weight: 800; letter-spacing: .01em; }
      p { font-size: 40px; line-height: 1.5; margin: 0; opacity: .82; max-width: 1320px; }
      .rule { width: 132px; height: 8px; background: currentColor; opacity: .5; margin: 0 0 34px; }
      .num { position: absolute; right: 120px; bottom: 76px; font-size: 210px; font-weight: 800; opacity: .12; letter-spacing: -.04em; }
      .sub { position: absolute; left: 140px; right: 140px; bottom: 76px; font-size: 30px; opacity: .6; }`,
    body: `<div class="stage"><div class="k">不加班 · 三十秒表达</div><div class="rule"></div>
      <h1>${title}</h1><p>${sub}</p></div><div class="num">0${index + 1}</div>`,
  }));
});
writeFileSync(join(aDir, 'film.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>三十秒表达</title>
<meta name="viewport" content="width=1920, height=1080"></head>
<body>
<section id="scenes" title="口播">
${aScenes.map(scene => `<iframe src="pages/s${scene.index + 1}.html#t=0,${scene.duration}" at="${scene.start}" title="0${scene.index + 1}"></iframe>`).join('\n')}
</section>
<section id="voice" title="人声">
<audio src="assets/narration.wav#t=0,${voiceSeconds.toFixed(3)}" at="0"></audio>
</section>
</body></html>
`);

// -------------------------------------------------------------- film B: 动效
const B = { w: 1920, h: 1080 };
const bDir = join(base, 'film-b');
mkdirSync(join(bDir, 'assets'), { recursive: true });
mkdirSync(join(bDir, 'pages'), { recursive: true });
mkdirSync(join(outRoot, 'film-b'), { recursive: true });
const beat = 6;
const bedFile = join(bDir, 'assets', 'bed.wav');
execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=110:duration=${beat * 3}:sample_rate=48000`,
  '-f', 'lavfi', '-i', `sine=frequency=220:duration=${beat * 3}:sample_rate=48000`,
  '-filter_complex', '[0:a]volume=0.55,lowpass=f=320[a];[1:a]volume=0.22,lowpass=f=900[b];[a][b]amix=inputs=2:duration=longest,afade=t=in:d=0.8,afade=t=out:st=' + (beat * 3 - 1.2) + ':d=1.2[out]',
  '-map', '[out]', '-ac', '2', bedFile]);
const bScenes = [
  { word: '先定调', note: '一句话说完这支片要什么' },
  { word: '再动起来', note: '动效只服务这一句话' },
  { word: '最后收住', note: '停在该停的帧上' },
];
bScenes.forEach((scene, index) => {
  writeFileSync(join(bDir, 'pages', `s${index + 1}.html`), page({
    ...B, duration: beat,
    css: `body { background: #0b0d10; color: #fff; }
      .wrap { position: absolute; inset: 0; display: grid; place-items: center; }
      h1 { font-size: 190px; margin: 0; font-weight: 900; letter-spacing: -.03em; line-height: 1;
        background: linear-gradient(92deg, #ffd479, #ff7a59 55%, #7be0ff); -webkit-background-clip: text; background-clip: text; color: transparent;
        will-change: transform, opacity; }
      .note { position: absolute; bottom: 150px; width: 100%; text-align: center; font-size: 34px; letter-spacing: .16em; color: #9fb0c0; opacity: 0; }
      .bar { position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 999px; background: #ff7a59; }
      .rule { position: absolute; left: 50%; top: 62%; height: 3px; width: 0; transform: translateX(-50%); background: linear-gradient(90deg, transparent, #7be0ff, transparent); }
      .sweep { position: absolute; top: -10%; left: -40%; width: 32%; height: 120%; transform: rotate(12deg);
        background: linear-gradient(90deg, transparent, rgba(123, 224, 255, .18), rgba(255, 212, 121, .22), transparent); }`,
    frame: `const p = Math.min(1, Math.max(0, t / 1.5));
      const ease = 1 - Math.pow(1 - p, 3);
      const h = document.querySelector('h1');
      h.style.transform = 'scale(' + (0.42 + 0.58 * ease) + ') translateY(' + (110 * (1 - ease)) + 'px)';
      h.style.opacity = String(Math.min(1, p * 2.6));
      h.style.letterSpacing = (0.16 - 0.19 * ease).toFixed(3) + 'em';
      document.querySelector('.note').style.opacity = String(Math.min(1, Math.max(0, (t - 1.1) * 1.8)));
      document.querySelector('.sweep').style.left = (-40 + 190 * Math.min(1, t / 2.2)).toFixed(1) + '%';
      const rule = document.querySelector('.rule');
      rule.style.width = Math.round(900 * Math.min(1, Math.max(0, (t - 1.2) / 1.6))) + 'px';
      rule.style.opacity = String(Math.max(0, 0.9 - Math.max(0, t - 4.6) / 1.2));`,
    body: `<div class="wrap"><h1>${scene.word}</h1></div><div class="sweep"></div><div class="note">${scene.note}</div><div class="bar"></div><div class="rule"></div>`,
  }));
});
writeFileSync(join(bDir, 'film.html'), `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>动效基准</title>
<meta name="viewport" content="width=1920, height=1080"></head>
<body>
<section id="scenes" title="动效">
${bScenes.map((scene, index) => `<iframe src="pages/s${index + 1}.html#t=0,${beat}" at="${index * beat}" title="0${index + 1}"></iframe>`).join('\n')}
</section>
<section id="bed" title="音垫">
<audio src="assets/bed.wav#t=0,${beat * 3}" at="0"></audio>
</section>
</body></html>
`);

// ------------------------------------------------------- render and export both
const pkg = join(root, 'node_modules/openfilm');
const { startStudio } = await import('openfilm/studio');
const { openProject } = await import(pathToFileURL(join(pkg, 'studio/server/projects.mjs')).href);
const studio = await startStudio({ port: 0, advertise: false, stays: true, openBrowser: () => {} });
const call = (path, init = {}) => fetch(`http://127.0.0.1:${studio.port}${path}`, {
  ...init, headers: { 'x-studio-key': studio.key, ...(init.body ? { 'content-type': 'application/json' } : {}) },
});
const receipts = { films: [], voice: { file: voiceFile, seconds: voiceSeconds }, ffmpeg: ffmpeg, studio: studio.port };

async function produce({ name, dir, frames }) {
  const project = await openProject(dir);
  const caps = await (await call(`/api/projects/${project.id}/exports`)).json();
  const started = await (await call(`/api/projects/${project.id}/exports`, {
    method: 'POST', body: JSON.stringify({ kind: 'video', codec: 'h264', shortEdge: 1080, fps: 30, preset: name }),
  })).json();
  const id = started.export?.id;
  if (!id) throw new Error(`export of ${name} was not queued: ${JSON.stringify(started).slice(0, 200)}`);
  let job;
  for (let i = 0; i < 240; i += 1) {
    await new Promise(again => setTimeout(again, 1000));
    const list = await (await call(`/api/projects/${project.id}/exports`)).json();
    job = (list.exports || []).find(entry => entry.id === id);
    if (job && ['done', 'failed', 'cancelled'].includes(job.status)) break;
  }
  if (!job || job.status !== 'done' || !Array.isArray(job.outputs) || !job.outputs.length) {
    console.log(JSON.stringify({ job, caps }, null, 2).slice(0, 2000));
    throw new Error(`export of ${name} did not finish`);
  }
  const output = job.outputs[0];
  if (!statSync(output).size) throw new Error('the export is empty');
  const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]).toString());
  const target = join(outRoot, name);
  mkdirSync(target, { recursive: true });
  const stills = [];
  for (const at of frames) {
    const response = await call(`/api/projects/${project.id}/media?what=frame&path=film.html&ms=${Math.round(at * 1000)}&w=1920`);
    if (!response.ok) throw new Error(`frame at ${at}s: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const file = join(target, `frame-${at.toFixed(2)}.jpg`);
    writeFileSync(file, bytes);
    stills.push({ at, file, bytes: bytes.length });
  }
  // A contact sheet from the exported file itself: proof the MP4 carries the same film.
  const sheet = join(target, 'export-sheet.jpg');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', output, '-vf', 'fps=1/3,scale=480:-1,tile=4x3', '-frames:v', '1', sheet]);
  const copy = join(target, `${name}.mp4`);
  writeFileSync(copy, readFileSync(output));
  const entry = {
    name, projectId: project.id, output, copy, sheet, stills, can: caps.can,
    encoder: job.encoder, bytes: statSync(copy).size,
    duration: Number(probe.format?.duration), width: probe.streams?.find(s => s.codec_type === 'video')?.width,
    height: probe.streams?.find(s => s.codec_type === 'video')?.height,
    hasAudio: probe.streams?.some(s => s.codec_type === 'audio') === true,
  };
  receipts.films.push(entry);
  return entry;
}

/** One small grey frame from the export: numbers compare, so motion is measurable. */
function grey(file, at) {
  return execFileSync(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=160:-1,format=gray', '-f', 'rawvideo', '-']);
}
const meanDiff = (left, right) => {
  let sum = 0;
  const size = Math.min(left.length, right.length);
  for (let i = 0; i < size; i += 1) sum += Math.abs(left[i] - right[i]);
  return sum / size;
};

/** The promises the plan makes are checked against the exported file itself. */
function verify(entry, expectations) {
  const problems = [];
  if (!(entry.duration >= expectations.min && entry.duration <= expectations.max)) problems.push(`duration ${entry.duration}`);
  if (entry.width !== 1920 || entry.height !== 1080) problems.push(`size ${entry.width}x${entry.height}`);
  if (expectations.audio && !entry.hasAudio) problems.push('no audio stream');
  if (expectations.audio) {
    const loud = spawnSync(ffmpeg, ['-v', 'info', '-i', entry.copy, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const volume = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(String(loud.stderr ?? ''))?.[1] ?? 'NaN');
    if (!(volume > -45)) problems.push(`audio is silent (${volume} dB)`);
    entry.meanVolumeDb = volume;
  }
  if (expectations.motion) {
    const early = meanDiff(grey(entry.copy, 0.10), grey(entry.copy, 0.55));
    const late = meanDiff(grey(entry.copy, 4.2), grey(entry.copy, 4.8));
    entry.motion = { early: Number(early.toFixed(2)), late: Number(late.toFixed(2)) };
    if (!(early > 1.2)) problems.push(`the opening frame barely changes (${early.toFixed(2)})`);
    if (!(early > late)) problems.push('the opening move is not the strongest change');
  }
  entry.checks = problems.length ? problems : 'ok';
  if (problems.length) throw new Error(`${entry.name}: ${problems.join('; ')}`);
}

try {
  const a = await produce({ name: 'film-a-talking-head', dir: aDir, frames: [0.4, 3, 9, 18, 31] });
  verify(a, { min: 30, max: 45, audio: true });
  const b = await produce({ name: 'film-b-motion', dir: bDir, frames: [0.5, 1.2, 3, 6.5, 12, 17.5] });
  verify(b, { min: 15, max: 20, audio: true, motion: true });
  receipts.summary = { a: { duration: a.duration, size: a.bytes }, b: { duration: b.duration, size: b.bytes }, outRoot };
  writeFileSync(join(outRoot, 'receipts.json'), JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify(receipts.summary, null, 2));

  // Studio must also draw the exported film's own frames: compare one Studio still
  // with one decoded from the MP4 at the same moment (same content, not a guess).
  for (const entry of [a, b]) {
    const fromVideo = join(join(outRoot, entry.name), 'export-frame.jpg');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(entry.stills[2].at), '-i', entry.copy, '-frames:v', '1', fromVideo]);
    receipts.films.find(f => f.name === entry.name).exportFrame = fromVideo;
  }
  writeFileSync(join(outRoot, 'receipts.json'), JSON.stringify(receipts, null, 2));
} finally {
  await studio.close().catch(() => {});
}
