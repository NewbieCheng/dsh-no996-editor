// Local, disposable Studio integration: no account, no model, no existing project.
// It exercises the actual HTTP search/take/edit/frame endpoints with two synthetic scenes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLibraryTool } from '../src/tools/library-tool.mjs';
import { createStudioHttp } from '../src/studio/studio-http.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'no996-transition-frame-'));
const project = join(temp, 'project');
const output = join(root, '.tmp-frames', `transition-${Date.now()}`);
process.env.OPENFILM_HOME = join(temp, 'home');
process.env.OPENFILM_SHARED_HOME = join(temp, 'home');
process.env.OPENFILM_NO_UPDATE_CHECK = '1';
mkdirSync(project);
mkdirSync(output, { recursive: true });
const page = (color, label) => `<!doctype html><html><head><meta name="viewport" content="width=1280, height=720"><style>html,body{margin:0;width:100%;height:100%;background:${color};color:white;font:800 120px Arial;display:grid;place-items:center}</style></head><body>${label}<script>window.film={width:1280,height:720,duration:3,ready:Promise.resolve(),frame(){}};</script></body></html>`;
writeFileSync(join(project, 'a.html'), page('#b42645', 'A'));
writeFileSync(join(project, 'b.html'), page('#2255ae', 'B'));
let studio;
try {
  const pkg = dirname(fileURLToPath(import.meta.resolve('openfilm/package.json')));
  const { filmHtml } = await import(pathToFileURL(join(pkg, 'src/film-doc.mjs')).href);
  const { openProject } = await import(pathToFileURL(join(pkg, 'studio/server/projects.mjs')).href);
  const { startStudio } = await import('openfilm/studio');
  writeFileSync(join(project, 'film.html'), filmHtml({ stage: { w: 1280, h: 720 }, tracks: [{ clips: [
    { id: 'a', src: 'a.html', at: 0, time: [0, 3] },
    { id: 'b', src: 'b.html', at: 3, time: [0, 3] },
  ] }] }));
  studio = await startStudio({ port: 0, advertise: false, stays: true, openBrowser: () => {} });
  const registered = await openProject(project);
  const http = createStudioHttp({ studio: async () => ({ origin: `http://127.0.0.1:${studio.port}`, key: studio.key }), timeoutMs: 90000 });
  const projectId = registered.id;
  const tool = createLibraryTool({ isProjectAgent: () => true, projectOf: () => ({ projectId, path: project }), http: () => http });
  const exec = { agent: {} };
  const search = await tool.execute({ kind: 'transition', query: 'glitch' }, exec);
  assert.match(search.text, /openfilm\/transitions\/glitch/);
  const film = await http.get(`/api/projects/${projectId}`);
  const taken = await tool.execute({ kind: 'transition', take: 'openfilm/transitions/glitch', cut: { before: 'a', after: 'b', revision: film.rev, saved: true } }, exec);
  assert.match(taken.text, /已放入切点/);
  const frames = [];
  for (const at of [2.5, 2.8, 2.88, 2.94, 3.0, 3.08, 3.12, 3.2, 3.5]) {
    const image = await http.picture(`/api/projects/${projectId}/media`, { query: { what: 'frame', path: 'film.html', ms: Math.round(at * 1000), w: 1280 }, timeout: 90000 });
    assert.ok(image.bytes.length > 1000 && image.type.startsWith('image/'));
    const target = join(output, `frame-${at.toFixed(2)}.jpg`);
    writeFileSync(target, image.bytes);
    frames.push({ at, path: target, bytes: image.bytes.length });
  }
  const result = { search: search.text, receipt: taken.text, frames };
  // The chain the plan promises ends in a real file, not a receipt: export the
  // project that now contains the placed transition and check the MP4 itself.
  const exportsBase = `/api/projects/${projectId}/exports`;
  const capabilities = await http.get(exportsBase);
  assert.equal(capabilities.can?.h264, true, 'this machine must be able to encode H.264');
  const started = await http.post(exportsBase, { body: { kind: 'video', codec: 'h264', shortEdge: 720, fps: 30 } });
  const jobId = started?.export?.id;
  assert.ok(jobId, 'the export must be queued');
  let job;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise(again => setTimeout(again, 1000));
    const list = await http.get(exportsBase);
    job = (list.exports || []).find(entry => entry.id === jobId);
    if (job && ['done', 'failed', 'cancelled'].includes(job.status)) break;
  }
  assert.equal(job?.status, 'done', `the export must finish: ${JSON.stringify(job)?.slice(0, 300)}`);
  assert.ok(job.outputs?.length && readFileSync(job.outputs[0]).length > 10_000, 'the export must be a real file');
  const exported = join(output, 'transition.mp4');
  writeFileSync(exported, readFileSync(job.outputs[0]));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', exported]).toString());
  result.export = { job: jobId, encoder: job.encoder, file: exported, bytes: readFileSync(exported).length, seconds: Number(probe.format.duration) };
  assert.ok(result.export.seconds >= 5.9 && result.export.seconds <= 6.2, `the exported film is the whole six seconds (got ${result.export.seconds})`);
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(result, null, 2));
  assert.ok(readFileSync(join(project, 'film.html'), 'utf8').includes('transitions-glitch'));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (studio) await studio.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
