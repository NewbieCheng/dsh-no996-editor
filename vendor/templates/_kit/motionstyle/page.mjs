import { escapeHtml, page } from '../render.mjs';

const text = value => escapeHtml(value ?? '');
const layer = (id, tag, value, cls = '') => `<${tag} data-element-id="${id}"${cls ? ` class="${cls}"` : ''}>${text(value)}</${tag}>`;

function flatScene(shot) {
  const c = shot.copy ?? {};
  return `${layer('motion-flat-kicker', 'p', c.kicker, 'label')}
    ${layer('motion-flat-headline', 'h1', c.headline, 'headline')}
    ${layer('motion-flat-deck', 'p', c.deck, 'deck')}
    <div class="flat-city" data-element-id="motion-flat-city">
      <svg viewBox="0 0 760 600" aria-hidden="true">
        <circle data-flat-sun cx="590" cy="122" r="76" fill="#ffc62b"/>
        <path d="M0 512h760" stroke="#fff6e9" stroke-width="12"/>
        <g fill="#ff5a4e"><rect x="64" y="304" width="132" height="208" rx="8"/><rect x="226" y="216" width="154" height="296" rx="8"/><rect x="566" y="266" width="130" height="246" rx="8"/></g>
        <g fill="#4d4dff"><rect x="410" y="132" width="126" height="380" rx="8"/><rect x="590" y="356" width="116" height="156" rx="8"/></g>
        <g fill="#fff6e9"><rect x="94" y="340" width="26" height="34"/><rect x="140" y="340" width="26" height="34"/><rect x="258" y="258" width="28" height="38"/><rect x="314" y="258" width="28" height="38"/><rect x="442" y="182" width="28" height="38"/><rect x="442" y="252" width="28" height="38"/></g>
        <path data-flat-road d="M28 548C214 454 462 460 726 396" fill="none" stroke="#2ee6a8" stroke-width="18" stroke-linecap="round"/>
      </svg>
      <span data-element-id="motion-flat-caption">${text(c.caption)}</span>
    </div>`;
}

function bauhausScene(shot) {
  const c = shot.copy ?? {};
  return `<div class="bauhaus-shapes" data-element-id="motion-bauhaus-shapes">
      <span class="bauhaus-band" data-bauhaus-band></span><span class="bauhaus-red" data-bauhaus-red></span><span class="bauhaus-blue" data-bauhaus-blue></span><span class="bauhaus-disc" data-bauhaus-disc></span>
    </div>
    ${layer('motion-bauhaus-kicker', 'p', c.kicker, 'label')}
    ${layer('motion-bauhaus-headline', 'h1', c.headline, 'headline')}
    ${layer('motion-bauhaus-deck', 'p', c.deck, 'deck')}
    <div class="bauhaus-rule" data-element-id="motion-bauhaus-rule"></div>
    ${layer('motion-bauhaus-number', 'p', '0%', 'number')}`;
}

/** Two editable motion studies distilled from the style samples. Text is DOM;
 * geometry is static SVG/CSS. Every animated value is a function of local t. */
export function render(shot, _catalog, options = {}) {
  const size = options.layout?.size ?? [1080, 1920];
  const landscape = size[0] > size[1];
  const flat = shot.id === 'shot-01';
  return page({ title: shot.pageTitle, size, styles: ['../assets/motion-scene.css'], scripts: ['../assets/motion.js'],
    body: `<main class="motion-study ${flat ? 'flat' : 'bauhaus'} ${landscape ? 'landscape' : 'portrait'}">${flat ? flatScene(shot) : bauhausScene(shot)}</main>`,
    script: `
  (function () {
    const M = window.Motion;
    const duration = ${shot.duration};
    const number = document.querySelector('[data-element-id="motion-bauhaus-number"]');
    function draw(value) {
      const t = Math.max(0, Math.min(duration, Number(value) || 0));
      const p = M.cubicOut(M.seg(t, 0.05, 0.62));
      const title = document.querySelector('.headline');
      title.style.clipPath = 'inset(0 ' + ((1 - p) * 100) + '% 0 0)';
      title.style.transform = 'translateY(' + ((1 - p) * 24) + 'px)';
      ${flat ? `
      const sun = document.querySelector('[data-flat-sun]');
      const road = document.querySelector('[data-flat-road]');
      sun.style.transformOrigin = '590px 122px';
      sun.style.transform = 'scale(' + (0.3 + 0.7 * M.backOut(M.seg(t, 0.2, 0.65))) + ')';
      road.style.strokeDasharray = '900';
      road.style.strokeDashoffset = String(900 * (1 - M.cubicOut(M.seg(t, 0.7, 1.1))));
      ` : `
      const red = document.querySelector('[data-bauhaus-red]');
      const blue = document.querySelector('[data-bauhaus-blue]');
      const disc = document.querySelector('[data-bauhaus-disc]');
      const band = document.querySelector('[data-bauhaus-band]');
      const rule = document.querySelector('[data-element-id="motion-bauhaus-rule"]');
      red.style.transform = 'translateX(' + (-160 * (1 - M.spring(M.seg(t, 0.1, 0.7), 0.7, 0.58))) + 'px)';
      blue.style.transform = 'translateX(' + (160 * (1 - M.spring(M.seg(t, 0.24, 0.7), 0.7, 0.58))) + 'px)';
      disc.style.transform = 'translateY(' + (120 * (1 - M.spring(M.seg(t, 0.45, 0.7)))) + 'px)';
      band.style.transform = 'scaleX(' + M.cubicOut(M.seg(t, 0.05, 0.5)) + ')';
      rule.style.transform = 'scaleX(' + M.cubicOut(M.seg(t, 1.1, 0.55)) + ')';
      if (number) number.textContent = Math.round(100 * M.cubicOut(M.seg(t, 0.8, 1.5))) + '%';
      `}
    }
    window.film = { width: ${size[0]}, height: ${size[1]}, duration,
      ready: Promise.resolve(document.fonts?.ready).then(function () { draw(0); return true; }),
      frame: draw };
  })();` });
}
