# No996 Scene Kit

Small, dependency-free building blocks for editable OpenFilm scenes. Text stays in DOM/SVG; `frame(t)` only changes styles and transforms.

```js
import { page, textLayer, subtitleLayer, safeArea } from '@newbiecheng/no996-scene-kit';

const html = page({
  title: 'A small experiment',
  size: [1080, 1920],
  body: textLayer({ id: 'headline', tag: 'h1', text: '<Keep this as text>' }),
});
```

- `textLayer` escapes display text and emits a stable `data-element-id`.
- `subtitleLayer` accepts `{ id, text, fromMs, toMs }` cues; it never executes text.
- `safeArea` and `cornerBox` compute native-pixel placement.
- `page` and `shotWall` compose self-contained static documents and accept only local relative assets.
- `./browser` exposes `No996Scene.createFilmRuntime` and `No996Scene.updateCaptions` for plain `<script>` pages.

The package does not read project files, access the network, start Studio, or open a browser. Node.js 22.2+; GPL-3.0-or-later.
