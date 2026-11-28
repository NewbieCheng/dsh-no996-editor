import { page, renderUnits } from '../render.mjs';

/** Portrait keeps the original stacked lecture layout. Landscape recomposes the
 * same editable units: courseware and presenter share the main row, while the
 * three-step scene becomes three columns. No portrait canvas is rotated. */
export function render(shot, catalog, options = {}) {
  const scope = { shot, copy: shot.copy ?? {} };
  const body = renderUnits(shot.units, catalog, scope);
  const vars = Object.entries(shot.vars ?? {})
    .map(([key, value]) => `  --${key}: ${value};`)
    .join('\n');
  const landscape = options.layout?.size?.[0] > options.layout?.size?.[1];
  const size = options.layout?.size ?? [1080, 1920];
  const style = [
    `:root {\n${vars}\n}`,
    shot.backdrop ? `body { background: ${shot.backdrop};${shot.relative ? ' position: relative;' : ''} }` : '',
    landscape ? LANDSCAPE : '',
  ].filter(Boolean).join('\n');
  const script = `  // A still page has the same DOM picture at every local time.
  window.film = { width: ${size[0]}, height: ${size[1]}, duration: ${shot.duration}, ready: document.fonts.ready, frame(_t) {} };`;
  return page({
    title: shot.pageTitle,
    styles: ['../assets/kit.css'],
    style,
    body: landscape ? `<main class="paper-page landscape">\n${body}\n</main>` : body,
    script,
    size,
  });
}

const LANDSCAPE = `
html, body { width: 1920px; height: 1080px; }
.paper-page { position: relative; width: 1920px; height: 1080px; overflow: hidden; }
.landscape .head { top: 64px; left: 84px; right: 84px; }
.landscape .kicker { font-size: 28px; }
.landscape .title { margin-top: 14px; font-size: 70px; line-height: 1.08; }
.landscape .stage { top: 250px; left: 84px; right: 704px; height: 590px; }
.landscape .slide b { font-size: 44px; }
.landscape .presenter { top: 250px; right: 84px; bottom: auto; width: 540px; height: 404px; font-size: 30px; }
.landscape .nameplate { left: auto; right: 84px; bottom: 158px; writing-mode: horizontal-tb; width: 540px; text-align: center; font-size: 30px; padding: 18px; }
.landscape .capsule { left: 84px; right: 84px; bottom: 54px; font-size: 32px; padding: 22px 40px; }
.landscape .steps { top: 250px; left: 84px; right: 84px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 28px; }
.landscape .step { min-width: 0; height: 590px; flex-direction: column; gap: 26px; padding: 38px 32px; }
.landscape .num { width: 78px; height: 78px; font-size: 38px; }
.landscape .body h3 { font-size: 44px; }
.landscape .body p { font-size: 28px; line-height: 1.55; }
`;
