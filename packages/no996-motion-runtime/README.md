# No996 Motion Runtime

Deterministic motion primitives for films whose picture is a pure function of time.

```js
import Motion from '@newbiecheng/no996-motion-runtime';
const eased = Motion.cubicOut(Motion.seg(t, 0.2, 0.6));
```

For a static film page, load `browser/no996-motion.js` and use `window.Motion` (also `window.No996Motion`). The ESM and browser exports contain the same closed-form functions: easing, springs, drops, deterministic noise, camera/pose interpolation, reveals, counters and surfaces.

No `Date.now`, `Math.random`, animation-frame loop, network access or previous-frame state belongs in a render function. The runtime itself never advances time. Node.js 22.2+; GPL-3.0-or-later. See `THIRD_PARTY_NOTICES.md` for the original scene-kit vocabulary attribution.
