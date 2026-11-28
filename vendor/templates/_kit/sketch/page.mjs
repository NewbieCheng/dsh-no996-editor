import { escapeHtml, page } from '../render.mjs';
import { NOTEBOOK } from './content.mjs';

const ink = value => escapeHtml(value ?? '');
const layer = (id, tag, value, cls = '') => `<${tag} data-element-id="${id}"${cls ? ` class="${cls}"` : ''}>${ink(value)}</${tag}>`;

function arrow(id, vertical) {
  return `<svg data-element-id="${id}" class="sketch-arrow ${vertical ? 'vertical' : ''}" viewBox="0 0 240 90" aria-hidden="true">
    <path d="M8 55C62 18 139 18 218 43M194 19l25 24-33 19" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function sceneBody(shot, landscape) {
  const n = Number(shot.id.slice(-2));
  const step = NOTEBOOK.steps[n - 2];
  if (n === 1) return `
    <div class="sketch-copy">${layer('sketch-kicker', 'p', NOTEBOOK.pageLabel, 'eyebrow')}
      ${layer('sketch-headline', 'h1', NOTEBOOK.title, 'display')}
      ${layer('sketch-deck', 'p', NOTEBOOK.subtitle, 'deck')}</div>
    <div class="sketch-hero" data-element-id="sketch-title-diagram">
      <svg viewBox="0 0 640 470" aria-hidden="true"><path d="M91 342C172 132 401 92 537 221"/><path d="M481 185l58 36-18 67"/><circle cx="91" cy="342" r="19"/><circle cx="537" cy="221" r="19"/></svg>
      <span data-element-id="sketch-title-note">听懂 ≠ 学会</span>
    </div>`;
  if (n === 7) return `
    <div class="sketch-copy">${layer('sketch-kicker', 'p', '一句话总结', 'eyebrow')}
      ${layer('sketch-headline', 'h1', NOTEBOOK.conclusion[0], 'display')}
      ${layer('sketch-deck', 'p', NOTEBOOK.conclusion[1], 'deck')}</div>
    <div class="sketch-summary" data-element-id="sketch-summary">${NOTEBOOK.steps.map((item, i) => `<div><b>${i + 1}</b><span>${ink(item.head)}</span></div>`).join('')}</div>`;
  if (n === 6) return `
    <div class="sketch-copy">${layer('sketch-kicker', 'p', '发现盲区之后', 'eyebrow')}
      ${layer('sketch-headline', 'h1', NOTEBOOK.returnLabel, 'display')}
      ${layer('sketch-deck', 'p', '把卡住的地方重新讲一遍，直到不再依赖术语。', 'deck')}</div>
    <div class="sketch-loop" data-element-id="sketch-loop-diagram"><svg viewBox="0 0 620 400" aria-hidden="true"><path d="M135 245C55 64 426 20 501 173c62 127-180 221-320 98-59-52-58-136 2-181"/><path d="M173 84l13 54-56 9"/></svg><b>② → ③ → ②</b></div>`;
  return `
    <div class="sketch-copy">${layer('sketch-kicker', 'p', `第 ${n - 1} 步`, 'eyebrow')}
      ${layer('sketch-headline', 'h1', step.head, 'display')}
      ${layer('sketch-deck', 'p', step.note[0], 'deck')}</div>
    <div class="sketch-step-card ${n === 4 ? 'sticky' : ''}" data-element-id="sketch-step-card">
      <span class="tape" data-composite-group="decorative-tape"></span>
      ${layer('sketch-step-number', 'b', String(n - 1), 'step-number')}
      ${layer('sketch-step-title', 'h2', step.head, 'step-title')}
      ${layer('sketch-step-note', 'p', step.note[1], 'step-note')}
      ${n === 4 ? layer('sketch-blindspot', 'p', '盲区就在这里', 'blindspot') : ''}
    </div>
    ${arrow(`sketch-arrow-${n}`, !landscape)}`;
}

/** Native-size paper scenes with editable text. The seven source windows stay
 * unchanged; portrait stacks copy/card, landscape places them side by side. */
export function render(shot, _catalog, options = {}) {
  const size = options.layout?.size ?? [1080, 1920];
  const landscape = size[0] > size[1];
  const index = Number(shot.id.slice(-2));
  const progress = Array.from({ length: 4 }, (_, i) => `<span data-step="${i + 1}" class="${index >= i + 2 ? 'done' : ''}">${i + 1}</span>`).join('');
  return page({ title: shot.pageTitle, size, styles: ['../assets/sketch.css'], style: '', body: `
  <main class="sketch-page ${landscape ? 'landscape' : 'portrait'}">
    <header class="sketch-header">${layer('sketch-series', 'span', '费曼笔记', 'series')}<span data-element-id="sketch-page-label">${ink(NOTEBOOK.pageLabel)}</span></header>
    <div class="sketch-progress" aria-label="学习步骤">${progress}</div>
    ${sceneBody(shot, landscape)}
    <footer class="sketch-footer">${layer('sketch-footer', 'span', index === 7 ? '讲清楚，才是真的懂了' : NOTEBOOK.steps[Math.min(3, Math.max(0, index - 1))].head)}</footer>
  </main>`, script: `
  (function () {
    const duration = ${shot.duration};
    const title = document.querySelector('[data-reveal]') || document.querySelector('.display');
    const card = document.querySelector('[data-element-id="sketch-step-card"], [data-element-id="sketch-title-diagram"], [data-element-id="sketch-summary"], [data-element-id="sketch-loop-diagram"]');
    const arrow = document.querySelector('.sketch-arrow path');
    function draw(value) {
      const t = Math.max(0, Math.min(duration, Number(value) || 0));
      const p = window.Motion.cubicOut(Math.min(1, t / 0.48));
      if (title) { title.style.clipPath = 'inset(0 ' + ((1 - p) * 100) + '% 0 0)'; }
      if (card) { card.style.opacity = String(p); card.style.transform = 'translateY(' + ((1 - p) * 22) + 'px)'; }
      if (arrow) { arrow.style.opacity = String(p); arrow.style.strokeDashoffset = String(420 * (1 - p)); }
    }
    window.film = { width: ${size[0]}, height: ${size[1]}, duration,
      ready: Promise.resolve(document.fonts?.ready).then(function () { draw(0); return true; }),
      frame: draw };
  })();`, scripts: ['../assets/motion.js'] });
}
