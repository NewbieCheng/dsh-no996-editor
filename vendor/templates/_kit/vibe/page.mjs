/**
 * Vibe 知识大赏模板的静态页面组装器（`_kit/vibe/page.mjs`）。
 *
 * 每个镜头由两份极简源文件组成：
 *   - `shots/shot-XX.json`      —— 文案、时长、配色覆盖、语义拍点、音效标签
 *   - `shots/shot-XX.scene.js`  —— `drawShot(api)` 纯函数渲染逻辑
 *
 * 构建期生成的 `pages/shot-XX.html` 完全自包含（不依赖 bundler/fetch）：
 *   1. 严格暴露 `window.film = { width, height, duration, ready, frame(t) }`；
 *   2. 自动兼容无 BGM（语义节拍）与有 BGM（读取同目录可选 `assets/rhythm-data.js`）；
 *   3. 独立打开页面（无 `window.filmHost`）时自动播放并带进度条调试预览。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeHtml } from '../render.mjs';

export function render(shot, _catalog, options = {}) {
  const templateDir = options.templateDir;
  if (!templateDir) throw new Error('vibe page renderer requires templateDir');
  const sceneFile = join(templateDir, 'shots', shot.scene || `${shot.id}.scene.js`);
  const sceneCode = readFileSync(sceneFile, 'utf8').trim();
  const [w, h] = Array.isArray(shot.size) && shot.size.length === 2 ? shot.size : [1080, 1920];
  const hasRhythm = existsSync(join(templateDir, 'assets', 'rhythm-data.js'));
  const shotData = JSON.stringify({
    id: shot.id,
    title: shot.title,
    chapter: shot.chapter || '',
    series: shot.series || 'VIBE 知识大赏',
    brand: shot.brand || '不加班智能团',
    duration: shot.duration,
    filmDuration: shot.filmDuration || shot.duration,
    start: shot.start || 0,
    bpm: shot.bpm || 112,
    palette: shot.palette || {},
    copy: shot.copy || {},
    vars: shot.vars || {},
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=${w}, height=${h}">
  <title>${escapeHtml(shot.title || shot.id)}</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #0a0c10; }
    canvas#stage { display: block; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <canvas id="stage" width="${w}" height="${h}"></canvas>
  <script src="../assets/motion.js"></script>
  <script src="../assets/vibe-canvas.js"></script>
  ${hasRhythm ? '<script src="../assets/rhythm-data.js"></script>\n  ' : ''}<script>
    (function () {
      'use strict';
      const SHOT = ${shotData};
      const canvas = document.getElementById('stage');
      const stage = window.VibeKit.createStage(canvas, { width: ${w}, height: ${h}, palette: SHOT.palette });
      const rhythm = window.VibeKit.readRhythm(SHOT.filmDuration, SHOT.bpm);

      ${sceneCode}

      function renderFrame(t) {
        const local = Math.max(0, Math.min(SHOT.duration, Number(t) || 0));
        const globalT = SHOT.start + local;
        const beatPulse = window.VibeKit.hitPulse(rhythm.beats, globalT, 0.22, rhythm.beatStrength);
        const onsetPulse = window.VibeKit.hitPulse(rhythm.onsets, globalT, 0.14, rhythm.onsetStrength);
        const beatIndex = window.VibeKit.lastAt(rhythm.beats, globalT);
        window.VibeKit.drawBackdrop(stage.ctx, globalT, { width: ${w}, height: ${h}, palette: stage.pal, beatPulse });
        if (typeof drawShot === 'function') {
          stage.ctx.save();
          drawShot({
            t: local,
            globalT,
            duration: SHOT.duration,
            ctx: stage.ctx,
            w: ${w},
            h: ${h},
            safe: stage.safe,
            pal: stage.pal,
            copy: SHOT.copy,
            vars: SHOT.vars,
            kit: window.VibeKit,
            motion: window.Motion,
            rhythm,
            beatPulse,
            onsetPulse,
          });
          stage.ctx.restore();
        }
        window.VibeKit.drawChrome(stage.ctx, globalT, {
          width: ${w},
          height: ${h},
          palette: stage.pal,
          series: SHOT.series,
          chapter: SHOT.chapter,
          brand: SHOT.brand,
          progress: globalT / Math.max(SHOT.filmDuration, 0.001),
          beatIndex,
          beatPulse,
        });
      }

      window.film = {
        width: ${w},
        height: ${h},
        duration: SHOT.duration,
        ready: (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(function () {
          renderFrame(0);
          return true;
        }),
        frame: function (t) {
          renderFrame(t);
        },
      };

      if (!window.filmHost) {
        const t0 = performance.now();
        const tick = function () {
          const elapsed = ((performance.now() - t0) / 1000) % SHOT.duration;
          renderFrame(elapsed);
          requestAnimationFrame(tick);
        };
        window.film.ready.then(tick);
      }
    })();
  </script>
</body>
</html>
`;
}
