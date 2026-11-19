/*
 * VibeKit (`window.VibeKit`): 通用解释性物理动效与 Canvas 2D 原子原语库。
 *
 * 蒸馏自 `vibe-bgm-skill` 与《容错率，是造出来的》实测视觉语法：
 *   1. 所有绘图函数均为只依赖 `t`（秒）的纯函数（禁 Math.random / Date.now），
 *      保证 OpenFilm 并行/乱序抽帧 100% 确定性。
 *   2. 兼容无 BGM（语义节拍兜底）与有 BGM（读取 `window.RHYTHM` 实测拍点与高潮）。
 *   3. 同时支持 9:16 竖屏（1080×1920）与 16:9 横屏（1920×1080），暴露完整原子原语
 *      与 6 大参数化物理隐喻组件，方便 AI 按主题自由原创，不被单一版式锁死。
 */
(function (root, factory) {
  const api = factory(root.Motion);
  root.VibeKit = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function (Motion) {
  'use strict';

  const DEFAULT_PALETTE = {
    BG: '#0a0c10',
    INK: '#f4f1ea',
    DIM: '#8d94a1',
    ACC: '#ffc24b',
    GOOD: '#4ff0b0',
    BAD: '#ff5c5c',
    BLUE: '#6aa8ff',
    PAPER: '#f1ede4',
    CARD: '#141820',
  };

  const FONT_STACK = '"PingFang SC","Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const E = {
    out: t => 1 - Math.pow(1 - clamp(t), 3),
    out5: t => 1 - Math.pow(1 - clamp(t), 5),
    inout: t => {
      const x = clamp(t);
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    },
    back: t => {
      const s = 1.70158;
      const u = clamp(t) - 1;
      return 1 + (s + 1) * u * u * u + s * u * u;
    },
    inn: t => {
      const x = clamp(t);
      return x * x * x;
    },
  };
  const P = (t, a, b, ease = E.out) => ease(clamp((t - a) / Math.max(b - a, 1e-4)));

  function mergePalette(overrides) {
    return Object.assign({}, DEFAULT_PALETTE, overrides || {});
  }

  /** 自适应安全区计算（支持 9:16 竖屏与 16:9 横屏）。 */
  function safeArea(w = 1080, h = 1920) {
    if (w > h) {
      return { w, h, left: 120, right: w - 120, top: 120, bottom: h - 130, cx: w / 2, cy: h / 2, span: w - 240 };
    }
    return { w, h, left: 94, right: w - 94, top: 170, bottom: h - 250, cx: w / 2, cy: h / 2, span: w - 188 };
  }

  /**
   * 读取 `window.RHYTHM`（若有音乐分析数据），否则构造平滑的语义节拍时间轴。
   * 返回的 `beats`/`onsets`/`tonal` 均以秒为单位。
   */
  function readRhythm(durationSec = 60, bpmFallback = 112) {
    const raw = (typeof window !== 'undefined' && window.RHYTHM) ? window.RHYTHM : null;
    if (raw && Array.isArray(raw.beats) && raw.beats.length > 0) {
      return {
        measured: true,
        bpm: raw.bpm || bpmFallback,
        beats: raw.beats.map(ms => ms / 1000),
        beatStrength: Array.isArray(raw.beatStrength) ? raw.beatStrength : null,
        onsets: Array.isArray(raw.onsets) ? raw.onsets.map(e => e[0] / 1000) : [],
        onsetStrength: Array.isArray(raw.onsets) ? raw.onsets.map(e => e[1]) : null,
        tonal: Array.isArray(raw.tonal) ? raw.tonal.map(e => e[0] / 1000) : [],
        climaxes: Array.isArray(raw.climaxes) ? raw.climaxes : [],
      };
    }
    const step = 60 / Math.max(40, bpmFallback);
    const beats = [];
    for (let t = 0; t <= durationSec + step; t += step) beats.push(Number(t.toFixed(4)));
    return {
      measured: false,
      bpm: bpmFallback,
      beats,
      beatStrength: null,
      onsets: beats,
      onsetStrength: null,
      tonal: [],
      climaxes: [],
    };
  }

  function lastAt(arr, t) {
    let lo = 0;
    let hi = arr.length - 1;
    let res = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (arr[m] <= t) { res = m; lo = m + 1; } else { hi = m - 1; }
    }
    return res;
  }

  function hitPulse(arr, t, dec = 0.18, strengths = null) {
    if (Motion && typeof Motion.pulse === 'function') return Motion.pulse(arr, t, dec, strengths);
    const i = lastAt(arr, t);
    if (i < 0) return 0;
    const amp = strengths && strengths[i] !== undefined ? 0.4 + 0.6 * strengths[i] : 1;
    return Math.exp(-(t - arr[i]) / Math.max(dec, 0.01)) * amp;
  }

  function steps(t, list, d = 0.4, ease = E.out) {
    if (Motion && typeof Motion.steps === 'function') return Motion.steps(t, list, d, ease);
    let k = 0;
    for (let i = 1; i < list.length; i += 1) if (t >= list[i][0]) k = i;
    if (k === 0) return list[0][1];
    return lerp(list[k - 1][1], list[k][1], ease(clamp((t - list[k][0]) / d)));
  }

  function det(frame, salt, index) {
    if (Motion && typeof Motion.det === 'function') return Motion.det(frame, salt, index);
    let x = (Math.imul(frame + 1, 73856093) ^ Math.imul(salt + 1, 19349663) ^ Math.imul(index + 1, 83492791)) | 0;
    x = (x ^ 61) ^ (x >>> 16);
    x = x + (x << 3);
    x = x ^ (x >>> 4);
    x = Math.imul(x, 0x27d4eb2d);
    return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
  }

  /** 初始化 Canvas 2D 画布并返回 `{ ctx, w, h, safe, pal }`。 */
  function createStage(canvas, opts = {}) {
    const w = opts.width || canvas.width || 1080;
    const h = opts.height || canvas.height || 1920;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    const pal = mergePalette(opts.palette);
    return { ctx, w, h, safe: safeArea(w, h), pal };
  }

  /* ------------------------------------------------------------ 原子绘图原语 */

  function setFont(ctx, size, weight = 800, family = FONT_STACK) {
    ctx.font = `${weight} ${size}px ${family}`;
  }

  function rr(ctx, x, y, w, h, r) {
    const rad = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, rad);
      return;
    }
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  function fillRR(ctx, x, y, w, h, r, fill, stroke, lw = 2) {
    rr(ctx, x, y, w, h, r);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  }

  function line(ctx, x1, y1, x2, y2, col, lw = 2, cap = 'round') {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.lineCap = cap;
    ctx.stroke();
  }

  function circ(ctx, x, y, r, fill, stroke, lw = 2) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  }

  function drawCheck(ctx, cx, cy, s, p, col, lw) {
    if (p <= 0) return;
    const pts = [[-0.5, 0.02], [-0.14, 0.4], [0.52, -0.38]];
    const l1 = Math.hypot(0.36, 0.38);
    const l2 = Math.hypot(0.66, 0.78);
    const d = clamp(p) * (l1 + l2);
    ctx.beginPath();
    ctx.moveTo(cx + pts[0][0] * s, cy + pts[0][1] * s);
    const a = Math.min(d, l1) / l1;
    ctx.lineTo(
      cx + (pts[0][0] + (pts[1][0] - pts[0][0]) * a) * s,
      cy + (pts[0][1] + (pts[1][1] - pts[0][1]) * a) * s,
    );
    if (d > l1) {
      const b = (d - l1) / l2;
      ctx.lineTo(
        cx + (pts[1][0] + (pts[2][0] - pts[1][0]) * b) * s,
        cy + (pts[1][1] + (pts[2][1] - pts[1][1]) * b) * s,
      );
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  function drawXMark(ctx, cx, cy, s, col, lw) {
    line(ctx, cx - s, cy - s, cx + s, cy + s, col, lw);
    line(ctx, cx + s, cy - s, cx - s, cy + s, col, lw);
  }

  function drawText(ctx, s, x, y, size, o = {}) {
    ctx.save();
    setFont(ctx, size, o.w || 800, o.font);
    ctx.textAlign = o.al || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha *= (o.a ?? 1);
    ctx.fillStyle = o.col || DEFAULT_PALETTE.INK;
    if (o.sh) { ctx.shadowColor = o.sh; ctx.shadowBlur = o.shb || 28; }
    ctx.fillText(s, x, y);
    ctx.restore();
  }

  function drawSegments(ctx, segs, x, y, size, o = {}) {
    const list = typeof segs === 'string' ? [[segs, o.col || DEFAULT_PALETTE.INK]] : segs;
    ctx.save();
    setFont(ctx, size, o.w || 800, o.font);
    ctx.textBaseline = 'alphabetic';
    const ws = list.map(item => ctx.measureText(item[0]).width);
    const tot = ws.reduce((a, b) => a + b, 0);
    let sx = o.al === 'center' ? x - tot / 2 : o.al === 'right' ? x - tot : x;
    ctx.globalAlpha *= (o.a ?? 1);
    ctx.textAlign = 'left';
    if (o.sh) { ctx.shadowColor = o.sh; ctx.shadowBlur = o.shb || 28; }
    list.forEach((item, i) => {
      ctx.fillStyle = item[1] || o.col || DEFAULT_PALETTE.INK;
      ctx.fillText(item[0], sx, y);
      sx += ws[i];
    });
    ctx.restore();
    return tot;
  }

  /** 逐字弹簧上浮（准备 → 运动 → 过冲落点 → 停稳）。 */
  function drawRiseText(ctx, segs, x, y, size, t, t0, o = {}) {
    if (t < t0) return 0;
    const list = typeof segs === 'string' ? [[segs, o.col || DEFAULT_PALETTE.INK]] : segs;
    const chars = [];
    list.forEach(([s, col]) => { for (const ch of s) chars.push([ch, col || o.col || DEFAULT_PALETTE.INK]); });
    ctx.save();
    setFont(ctx, size, o.w || 800, o.font);
    const ws = chars.map(([ch]) => ctx.measureText(ch).width);
    const tot = ws.reduce((a, b) => a + b, 0);
    let sx = o.al === 'center' ? x - tot / 2 : o.al === 'right' ? x - tot : x;
    const per = o.per ?? 0.04;
    const dur = o.dur ?? 0.38;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    chars.forEach(([ch, col], i) => {
      const u = (t - t0 - i * per) / dur;
      const a = clamp(u / 0.6);
      if (a > 0) {
        const p = E.back(clamp(u));
        ctx.save();
        ctx.globalAlpha *= (o.a ?? 1) * a;
        ctx.fillStyle = col;
        if (o.sh) { ctx.shadowColor = o.sh; ctx.shadowBlur = o.shb || 24; }
        ctx.translate(sx + ws[i] / 2, y + (1 - p) * size * 0.45);
        const sc = 0.82 + 0.18 * p;
        ctx.scale(sc, sc);
        ctx.fillText(ch, 0, 0);
        ctx.restore();
      }
      sx += ws[i];
    });
    ctx.restore();
    return tot;
  }

  /** 重击砸入：落点对齐 t0，带尺度冲击与落定余震。 */
  function drawSlamText(ctx, segs, x, y, size, t, t0, o = {}) {
    const p = clamp((t - t0) / (o.dur ?? 0.34));
    if (p <= 0) return;
    const e = E.out(p);
    const sc = lerp(o.fromScale ?? 1.45, 1, e);
    const sh = t > t0 + 0.05 ? Math.sin((t - t0) * 95) * 9 * Math.exp(-(t - t0) * 16) : 0;
    ctx.save();
    ctx.globalAlpha *= clamp(p * 3) * (o.a ?? 1);
    const cy = y - size * 0.35;
    ctx.translate(x + sh, cy);
    ctx.scale(sc, sc);
    ctx.translate(-x, -cy);
    drawSegments(ctx, segs, x, y, size, { al: o.al || 'center', sh: o.sh, shb: o.shb, w: o.w, col: o.col });
    ctx.restore();
  }

  function drawUnderline(ctx, x1, x2, y, t, t0, dur, col, lw = 8) {
    const p = P(t, t0, t0 + dur);
    if (p > 0) line(ctx, x1, y, lerp(x1, x2, p), y, col, lw);
  }

  function drawTag(ctx, txt, x, y, t, t0, col = DEFAULT_PALETTE.ACC) {
    const a = P(t, t0, t0 + 0.35);
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha *= a;
    setFont(ctx, 32, 700);
    const w = ctx.measureText(txt).width + 56;
    fillRR(ctx, x, y - 46 + (1 - a) * 18, w, 70, 35, 'rgba(255,255,255,.05)', col, 3);
    ctx.restore();
    drawText(ctx, txt, x + 28, y + 2 + (1 - a) * 18, 32, { w: 700, col, a });
  }

  function drawBigNum(ctx, txt, t, t0, col = DEFAULT_PALETTE.ACC, x = 80, y = 700) {
    const a = P(t, t0, t0 + 0.5, E.out5);
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha *= a;
    ctx.translate(-(1 - a) * 160, 0);
    setFont(ctx, 380, 900);
    ctx.lineWidth = 4;
    ctx.strokeStyle = col;
    ctx.fillStyle = 'rgba(255,194,75,.12)';
    ctx.textAlign = 'left';
    ctx.strokeText(txt, x, y);
    ctx.fillText(txt, x, y);
    ctx.restore();
  }

  /** 时间区块包装器：自动处理进出渐隐上收。 */
  function blk(ctx, t, a, b, fn, keep = false) {
    if (t < a || t >= b) return;
    const ex = keep ? 1 : E.out(clamp((b - t) / 0.22));
    ctx.save();
    ctx.globalAlpha *= ex;
    ctx.translate(0, (1 - ex) * -56);
    fn();
    ctx.restore();
  }

  /* ------------------------------------------------------------ 氛围背景与转场 */

  /** 暗场质感底图：主题径向光晕 + 节拍呼吸点阵 + 暗角 + 确定性 30fps 胶片颗粒。 */
  function drawBackdrop(ctx, t, opts = {}) {
    const w = opts.width || ctx.canvas.width || 1080;
    const h = opts.height || ctx.canvas.height || 1920;
    const pal = mergePalette(opts.palette);
    const bp = opts.beatPulse || 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = pal.BG;
    ctx.fillRect(0, 0, w, h);

    const g = ctx.createRadialGradient(w * 0.5, h * 0.4, 80, w * 0.5, h * 0.4, Math.max(w, h) * 0.65);
    g.addColorStop(0, opts.glowColor || 'rgba(255,194,75,.07)');
    g.addColorStop(1, 'rgba(255,194,75,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const spacing = 70;
    const off = (t * 7) % spacing;
    ctx.fillStyle = 'rgba(244,241,234,.07)';
    for (let y = -spacing + off; y < h + spacing; y += spacing) {
      for (let x = 35; x < w; x += spacing) {
        const r = 1.8 + bp * 1.4;
        ctx.fillRect(x - r / 2, y - r / 2, r, r);
      }
    }

    const v = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.48, w * 0.5, h * 0.5, Math.max(w, h) * 0.72);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,.58)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, w, h);

    // Deterministic 30fps film grain (no Math.random).
    const frame = Math.floor(t * 30);
    const grainCount = opts.grainCount === undefined ? 96 : opts.grainCount;
    if (grainCount > 0) {
      ctx.save();
      ctx.globalAlpha = 0.05;
      ctx.fillStyle = pal.INK;
      for (let i = 0; i < grainCount; i += 1) {
        const gx = det(frame, 17, i) * w;
        const gy = det(frame, 31, i) * h;
        const gs = 1 + det(frame, 43, i) * 1.6;
        ctx.fillRect(gx, gy, gs, gs);
      }
      ctx.restore();
    }
  }

  /** 极简常驻框架：顶部品牌角标/章名 + 底部 4 拍指示点与进度线。 */
  function drawChrome(ctx, t, opts = {}) {
    const w = opts.width || ctx.canvas.width || 1080;
    const h = opts.height || ctx.canvas.height || 1920;
    const pal = mergePalette(opts.palette);
    const safe = safeArea(w, h);
    const fin = P(t, 0, 0.5);
    const progress = clamp(opts.progress ?? 0);
    const beatIndex = opts.beatIndex ?? -1;
    const bp = opts.beatPulse ?? 0;

    ctx.save();
    ctx.globalAlpha = fin;
    const topY = w > h ? 64 : 82;
    fillRR(ctx, safe.left, topY, 18, 18, 4, pal.ACC);
    drawText(ctx, opts.series || 'VIBE 知识大赏', safe.left + 32, topY + 18, 30, { w: 700, col: pal.INK, a: 0.9 });
    if (opts.chapter) {
      drawText(ctx, opts.chapter, safe.right, topY + 18, 28, { w: 600, col: pal.DIM, al: 'right' });
    }
    const dotsY = h - (w > h ? 115 : 198);
    const cur = beatIndex < 0 ? -1 : beatIndex % 4;
    for (let i = 0; i < 4; i += 1) {
      const dx = safe.cx + (i - 1.5) * 44;
      circ(ctx, dx, dotsY, i === cur ? 9 + 5 * bp : 6, i === cur ? pal.ACC : 'rgba(244,241,234,.22)');
    }
    const barY = h - (w > h ? 72 : 130);
    line(ctx, safe.left, barY, safe.right, barY, 'rgba(244,241,234,.18)', 4, 'butt');
    line(ctx, safe.left, barY, safe.left + safe.span * progress, barY, pal.ACC, 4, 'butt');
    if (opts.brand) {
      drawText(ctx, opts.brand, safe.cx, barY + (w > h ? 46 : 68), 28, { w: 600, col: pal.DIM, al: 'center', a: 0.9 });
    }
    ctx.restore();
  }

  /** 琥珀金扫描光带转场（在切点 t0 前 0.16s 起扫）。 */
  function drawWipeBand(ctx, t, t0, opts = {}) {
    const w = opts.width || ctx.canvas.width || 1080;
    const h = opts.height || ctx.canvas.height || 1920;
    const pal = mergePalette(opts.palette);
    const dur = opts.duration ?? 0.46;
    const u = (t - (t0 - 0.16)) / dur;
    if (u < 0 || u > 1) return;
    const x = lerp(-260, w + 260, E.inout(u));
    const g = ctx.createLinearGradient(x - 260, 0, x, 0);
    g.addColorStop(0, 'rgba(255,194,75,0)');
    g.addColorStop(1, 'rgba(255,194,75,.55)');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(x - 260, 0, 260, h);
    ctx.fillStyle = pal.ACC;
    ctx.fillRect(x - 4, 0, 8, h);
    ctx.restore();
  }

  /* ------------------------------------------------------ 6 大物理隐喻组件 */

  /** 1. 动态杠杆天平（反比/权衡关系）。 */
  function drawScale(ctx, opts = {}) {
    const pal = mergePalette(opts.palette);
    const cx = opts.cx ?? 540;
    const cy = opts.cy ?? 1010;
    const L = opts.arm ?? 300;
    const dropLen = opts.dropLen ?? 260;
    const cost = clamp(opts.cost ?? 1, 0.12, 1);
    const alpha = opts.alpha ?? 1;
    const th = (cost - (1 - cost)) * 0.30;

    ctx.save();
    ctx.globalAlpha *= alpha;
    line(ctx, cx, cy, cx, cy + 330, pal.DIM, 8);
    line(ctx, cx - 130, cy + 330, cx + 130, cy + 330, pal.DIM, 12);
    const lx = cx - L * Math.cos(th);
    const ly = cy + L * Math.sin(th);
    const rx = cx + L * Math.cos(th);
    const ry = cy - L * Math.sin(th);
    line(ctx, lx, ly, rx, ry, pal.INK, 14);
    circ(ctx, cx, cy, 20, pal.ACC);

    const sizeL = 70 + cost * 150;
    const inv = 1 / cost;
    const sizeR = 70 + clamp((inv - 1) / 4.55) * 150;
    const sides = [
      [lx, ly, sizeL, pal.BAD, opts.leftLabel || '试错成本', opts.leftValue || (Math.round(cost * 100) + '%')],
      [rx, ry, sizeR, pal.GOOD, opts.rightLabel || '容错率', opts.rightValue || ('×' + inv.toFixed(1))],
    ];
    sides.forEach(([px, py, sz, col, name, val]) => {
      const top = py + dropLen;
      line(ctx, px, py, px - 120, top, 'rgba(244,241,234,.5)', 3);
      line(ctx, px, py, px + 120, top, 'rgba(244,241,234,.5)', 3);
      fillRR(ctx, px - 130, top, 260, 18, 9, pal.INK);
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = 30;
      fillRR(ctx, px - sz / 2, top - sz, sz, sz, 18, col);
      ctx.restore();
      drawText(ctx, name, px, top + 76, 42, { w: 700, col: pal.DIM, al: 'center' });
      drawText(ctx, val, px, top + 148, 66, { w: 900, col, al: 'center' });
    });
    ctx.restore();
  }

  /** 2. 单/双向门 + 角色球体物理弹撞。 */
  function drawDoorFrame(ctx, cx, cy, closed, col, arrowType, pal) {
    const w = 220;
    const h = 420;
    const pw = (w / 2) * clamp(closed);
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,.04)';
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    if (pw > 0) {
      ctx.save();
      ctx.globalAlpha *= 0.9;
      ctx.fillStyle = col;
      ctx.fillRect(cx - w / 2, cy - h / 2, pw, h);
      ctx.fillRect(cx + w / 2 - pw, cy - h / 2, pw, h);
      ctx.restore();
    }
    line(ctx, cx - w / 2, cy + h / 2, cx - w / 2, cy - h / 2, pal.INK, 9);
    line(ctx, cx - w / 2, cy - h / 2, cx + w / 2, cy - h / 2, pal.INK, 9);
    line(ctx, cx + w / 2, cy - h / 2, cx + w / 2, cy + h / 2, pal.INK, 9);
    line(ctx, cx - w / 2 - 70, cy + h / 2, cx + w / 2 + 70, cy + h / 2, pal.DIM, 4);
    const ay = cy - h / 2 - 48;
    if (arrowType === 1) {
      line(ctx, cx - 70, ay, cx + 50, ay, col, 8);
      line(ctx, cx + 50, ay, cx + 28, ay - 20, col, 8);
      line(ctx, cx + 50, ay, cx + 28, ay + 20, col, 8);
      line(ctx, cx + 80, ay - 26, cx + 80, ay + 26, col, 10);
    } else {
      line(ctx, cx - 70, ay, cx + 70, ay, col, 8);
      line(ctx, cx + 70, ay, cx + 48, ay - 20, col, 8);
      line(ctx, cx + 70, ay, cx + 48, ay + 20, col, 8);
      line(ctx, cx - 70, ay, cx - 48, ay - 20, col, 8);
      line(ctx, cx - 70, ay, cx - 48, ay + 20, col, 8);
    }
    ctx.restore();
  }

  function drawActorBall(ctx, x, y, label = '你', pal = DEFAULT_PALETTE, alpha = 1) {
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.shadowColor = pal.ACC;
    ctx.shadowBlur = 24;
    circ(ctx, x, y, 36, pal.ACC);
    ctx.shadowBlur = 0;
    drawText(ctx, label, x, y + 12, 34, { w: 900, col: pal.BG, al: 'center' });
    ctx.restore();
  }

  function drawDoors(ctx, opts = {}) {
    const pal = mergePalette(opts.palette);
    const cy = opts.cy ?? 880;
    const by = cy + 210 - 36;
    const leftX = opts.leftX ?? 300;
    const rightX = opts.rightX ?? 780;
    ctx.save();
    ctx.globalAlpha *= (opts.alpha ?? 1);
    drawDoorFrame(ctx, leftX, cy, opts.leftClosed ?? 0, pal.BAD, 1, pal);
    drawDoorFrame(ctx, rightX, cy, opts.rightClosed ?? 0, pal.GOOD, 2, pal);
    drawActorBall(ctx, opts.actorLeftX ?? leftX - 200, by, opts.actorLabel || '你', pal, 1);
    drawActorBall(ctx, opts.actorRightX ?? rightX - 200, by, opts.actorLabel || '你', pal, 1);
    ctx.restore();
  }

  /** 3. 大块裂解 + 坠落 + 单块展开 + 止损线。 */
  function drawSplitBar(ctx, opts = {}) {
    const pal = mergePalette(opts.palette);
    const x0 = opts.x ?? 94;
    const y = opts.y ?? 520;
    const tw = opts.width ?? 892;
    const hh = opts.height ?? 176;
    const n = opts.count ?? 6;
    const split = clamp(opts.split ?? 0);
    const fall = clamp(opts.fall ?? 0);
    const pick = clamp(opts.pick ?? 0);
    const pw = (tw - (n - 1) * 10) / n;

    if (split === 0) {
      const p = clamp(opts.enter ?? 1);
      ctx.save();
      ctx.globalAlpha *= p;
      ctx.translate(0, (1 - p) * 50);
      fillRR(ctx, x0, y, tw, hh, 26, 'rgba(255,92,92,.14)', pal.BAD, 5);
      drawText(ctx, opts.wholeText || '3 个月 · 整个方向 · 一次押满', x0 + tw / 2, y + 106, 46, { w: 800, col: pal.BAD, al: 'center' });
      ctx.restore();
      return;
    }

    for (let i = 0; i < n; i += 1) {
      const full = x0 + i * (tw / n);
      const x = lerp(full, x0 + i * (pw + 10), split);
      const w2 = lerp(tw / n, pw, split);
      const yy = i === 0 ? y : y + fall * 680;
      const a = i === 0 ? 1 : 1 - fall;
      ctx.save();
      ctx.globalAlpha *= a;
      if (i === 0 && pick > 0) {
        const ww = lerp(w2, tw, pick);
        fillRR(ctx, x0, y, ww, hh, 26, 'rgba(255,194,75,.2)', pal.ACC, 5);
        if (pick > 0.6) {
          drawText(ctx, opts.focusText || '先只做这 1 块 · 2 周', x0 + tw / 2, y + 106, 48, { w: 800, col: pal.ACC, al: 'center', a: (pick - 0.6) / 0.4 });
        }
      } else {
        fillRR(ctx, x, yy, w2, hh, 18, 'rgba(255,92,92,.14)', pal.BAD, 3);
        drawText(ctx, opts.pieceText || '2周', x + w2 / 2, yy + 102, 36, { w: 700, col: pal.BAD, al: 'center' });
      }
      ctx.restore();
    }
  }

  /** 4. 跑道消耗与扩容格。 */
  function drawRunway(ctx, opts = {}) {
    const pal = mergePalette(opts.palette);
    const x0 = opts.x ?? 100;
    const y0 = opts.y ?? 830;
    const cw = opts.cellWidth ?? 66;
    const gp = opts.gap ?? 8;
    const total = opts.total ?? 12;
    const baseFilled = opts.baseFilled ?? 3;
    const burnRates = opts.burnRates ?? [];
    const added = opts.added ?? [];

    ctx.save();
    ctx.globalAlpha *= (opts.alpha ?? 1);
    for (let i = 0; i < total; i += 1) {
      fillRR(ctx, x0 + i * (cw + gp), y0, cw, 150, 12, null, 'rgba(244,241,234,.2)', 3);
    }
    for (let i = 0; i < baseFilled; i += 1) {
      const bv = clamp(burnRates[i] ?? 0);
      const col = bv > 0.5 ? pal.BAD : pal.ACC;
      ctx.save();
      ctx.globalAlpha *= 1 - bv * 0.75;
      ctx.shadowColor = col;
      ctx.shadowBlur = 20;
      fillRR(ctx, x0 + i * (cw + gp) + 5, y0 + 5, cw - 10, 140, 8, col);
      ctx.restore();
    }
    for (let j = 0; j < added.length; j += 1) {
      const idx = baseFilled + j;
      const q = clamp(added[j], 0, 1.2);
      if (q <= 0 || idx >= total) continue;
      ctx.save();
      ctx.globalAlpha *= clamp(q);
      ctx.translate(x0 + idx * (cw + gp) + cw / 2, y0 + 75);
      ctx.scale(q, q);
      ctx.shadowColor = pal.GOOD;
      ctx.shadowBlur = 24;
      fillRR(ctx, -cw / 2 + 5, -70, cw - 10, 140, 8, pal.GOOD);
      ctx.restore();
    }
    ctx.restore();
  }

  /** 5. 96 格虚拟试错收敛网格 → 塌缩为唯一成功态。 */
  function drawSimGrid(ctx, opts = {}) {
    const pal = mergePalette(opts.palette);
    const x0 = opts.x ?? 112;
    const y0 = opts.y ?? 690;
    const cell = opts.cell ?? 64;
    const gap = opts.gap ?? 8;
    const cols = opts.cols ?? 12;
    const rows = opts.rows ?? 8;
    const total = cols * rows;
    const times = opts.times || [];
    const order = opts.order || Array.from({ length: total }, (_, i) => i);
    const keepIndex = opts.keepIndex ?? 41;
    const collapse = clamp(opts.collapse ?? 0);
    const t = opts.t ?? 0;
    const nShown = Math.min(total, lastAt(times, t) + 1);
    const targetX = opts.targetX ?? 540;
    const targetY = opts.targetY ?? 940;

    for (let n = 0; n < nShown; n += 1) {
      const idx = order[n];
      if (idx === keepIndex && collapse > 0) continue;
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const age = Math.max(0, t - (times[n] ?? 0));
      const pop = E.back(clamp(age / 0.22));
      const x = x0 + col * (cell + gap) + cell / 2;
      const y = y0 + row * (cell + gap) + cell / 2;
      const cx = lerp(x, targetX, collapse);
      const cy = lerp(y, targetY, collapse);
      const flash = clamp(1 - age / 0.25);
      ctx.save();
      ctx.globalAlpha *= 1 - collapse;
      ctx.translate(cx, cy);
      ctx.scale(pop, pop);
      fillRR(ctx, -cell / 2, -cell / 2, cell, cell, 12, `rgba(255,92,92,${0.18 + flash * 0.5})`, pal.BAD, 3);
      drawXMark(ctx, 0, 0, 14, pal.BAD, 6);
      ctx.restore();
    }
    return nShown;
  }

  /** 6. 打卡波纹清单卡片。 */
  function drawChecklistRow(ctx, opts = {}) {
    const pal = mergePalette(opts.palette);
    const x = opts.x ?? 94;
    const y = opts.y ?? 520;
    const w = opts.width ?? 892;
    const h = opts.height ?? 220;
    const enter = clamp(opts.enter ?? 1);
    const doneP = clamp(opts.done ?? 0);
    const ripple = clamp(opts.ripple ?? 0);
    const isDone = doneP > 0;

    ctx.save();
    ctx.globalAlpha *= clamp(enter * 2.5);
    ctx.translate((1 - E.back(enter)) * 220, 0);
    fillRR(ctx, x, y, w, h, 36, pal.CARD, 'rgba(244,241,234,.18)', 3);
    circ(ctx, x + 90, y + h / 2, 44, pal.ACC);
    drawText(ctx, String(opts.num ?? 1), x + 90, y + h / 2 + 21, 58, { w: 900, col: pal.BG, al: 'center' });
    drawText(ctx, opts.title || '', x + 168, y + h * 0.48, 54, { col: pal.INK });
    drawText(ctx, opts.sub || '', x + 168, y + h * 0.74, 34, { w: 500, col: pal.DIM });
    const boxX = x + w - 136;
    const boxY = y + h / 2 - 37;
    fillRR(ctx, boxX, boxY, 74, 74, 16, isDone ? 'rgba(79,240,176,.18)' : null, isDone ? pal.GOOD : 'rgba(244,241,234,.45)', 5);
    if (isDone) drawCheck(ctx, boxX + 37, boxY + 39, 54, doneP, pal.GOOD, 10);
    ctx.restore();

    if (isDone && ripple > 0 && ripple < 1) {
      ctx.save();
      ctx.globalAlpha *= 1 - ripple;
      circ(ctx, x + w - 99, y + h / 2 + 2, 40 + ripple * 70, null, pal.GOOD, 5);
      ctx.restore();
    }
  }

  /* -------------------------------------------------- 2.5D 相机与景深视差 */

  /** 围绕画布中心施加虚拟 2.5D 相机变换（推拉缩放 / 平移 / 倾角）。 */
  function withCamera(ctx, w, h, cam, fn) {
    if (typeof fn !== 'function') return;
    const c = cam || {};
    const zoom = c.zoom === undefined ? 1 : c.zoom;
    const x = c.x || 0;
    const y = c.y || 0;
    const rotate = c.rotate || 0;
    ctx.save();
    ctx.translate(w * 0.5 + x, h * 0.5 + y);
    if (rotate && typeof ctx.rotate === 'function') ctx.rotate((rotate * Math.PI) / 180);
    ctx.scale(zoom, zoom);
    ctx.translate(-w * 0.5, -h * 0.5);
    fn();
    ctx.restore();
  }

  /** 按景深系数 depth（背景 0.3 / 主体 1.0 / 前景 1.35）施加视差相机。 */
  function withParallax(ctx, w, h, cam, depth, fn) {
    const d = depth === undefined ? 1 : depth;
    const c = cam || {};
    return withCamera(ctx, w, h, {
      x: (c.x || 0) * d,
      y: (c.y || 0) * d,
      zoom: 1 + ((c.zoom === undefined ? 1 : c.zoom) - 1) * d,
      rotate: (c.rotate || 0) * Math.min(1, d),
    }, fn);
  }

  /* ---------------------------------------- 6 大“从上一幕自然生长”转场原语 */

  const grow = {
    /** 1. 几何形变扩张：上一幕容器连续变形/变色长成下一幕舞台。 */
    morphExpand(ctx, fromRect, toRect, p, opts = {}) {
      const pal = mergePalette(opts.palette);
      const u = clamp(p);
      const box = Motion && typeof Motion.morphBox === 'function'
        ? Motion.morphBox(fromRect, toRect, u)
        : {
          x: lerp(fromRect.x || 0, toRect.x || 0, E.inout(u)),
          y: lerp(fromRect.y || 0, toRect.y || 0, E.inout(u)),
          w: lerp(fromRect.w || 100, toRect.w || 400, E.inout(u)),
          h: lerp(fromRect.h || 100, toRect.h || 400, E.inout(u)),
          r: lerp(fromRect.r || 16, toRect.r || 28, E.inout(u)),
          rotate: lerp(fromRect.rotate || 0, toRect.rotate || 0, E.inout(u)),
        };
      const fill = Motion && typeof Motion.colorLerp === 'function' && opts.fromFill && opts.toFill
        ? Motion.colorLerp(opts.fromFill, opts.toFill, u)
        : (opts.fill || pal.CARD);
      const stroke = opts.stroke || pal.ACC;
      ctx.save();
      ctx.translate(box.x + box.w * 0.5, box.y + box.h * 0.5);
      if (box.rotate && typeof ctx.rotate === 'function') ctx.rotate((box.rotate * Math.PI) / 180);
      if (opts.glow) {
        ctx.shadowColor = opts.glow;
        ctx.shadowBlur = 24 + 16 * Math.sin(u * Math.PI);
      }
      fillRR(ctx, -box.w * 0.5, -box.h * 0.5, box.w, box.h, box.r, fill, stroke, opts.lw || 3);
      ctx.restore();
      return box;
    },

    /** 2. 穿越式光圈/字腔钻入：从焦点圆 (cx, cy) 放大并裁切展开下一幕世界。 */
    portalZoom(ctx, cx, cy, startR, endR, p, drawInner, opts = {}) {
      const u = E.inout(clamp(p));
      if (u <= 0.001) return;
      const radius = lerp(startR, endR, u);
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, radius), 0, Math.PI * 2);
      if (typeof ctx.clip === 'function') ctx.clip();
      if (typeof drawInner === 'function') drawInner(u, radius);
      ctx.restore();
      if (opts.ringColor && u < 0.96) {
        ctx.save();
        ctx.globalAlpha *= (1 - u) * 0.9;
        circ(ctx, cx, cy, Math.max(1, radius), null, opts.ringColor, opts.ringWidth || 5);
        ctx.restore();
      }
    },

    /** 3. 线条接力生长：上一幕路径沿控制点延伸拐角，勾勒出下一幕画框。 */
    lineCarry(ctx, points, p, opts = {}) {
      const pal = mergePalette(opts.palette);
      const u = E.inout(clamp(p));
      if (u <= 0 || !Array.isArray(points) || points.length < 2) return null;
      const state = Motion && typeof Motion.pathProgress === 'function'
        ? Motion.pathProgress(points, u)
        : { x: points[points.length - 1].x, y: points[points.length - 1].y, angle: 0, partial: points };
      const pts = state.partial || points;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = opts.color || pal.ACC;
      ctx.lineWidth = opts.lw || 6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (opts.glow !== false) {
        ctx.shadowColor = opts.color || pal.ACC;
        ctx.shadowBlur = 18;
      }
      ctx.stroke();
      circ(ctx, state.x, state.y, (opts.lw || 6) * 1.4, opts.headColor || '#ffffff');
      ctx.restore();
      return state;
    },

    /** 4. 因果冲击波揭示：从点击/碰撞原点 (ox, oy) 径向扩张揭开下一幕。 */
    causalRipple(ctx, ox, oy, maxR, p, drawNext, opts = {}) {
      const pal = mergePalette(opts.palette);
      const u = E.out5(clamp(p));
      if (u <= 0.001) return;
      const rad = Math.max(1, u * maxR);
      ctx.save();
      ctx.beginPath();
      ctx.arc(ox, oy, rad, 0, Math.PI * 2);
      if (typeof ctx.clip === 'function') ctx.clip();
      if (typeof drawNext === 'function') drawNext(u);
      ctx.restore();
      if (u < 0.98) {
        ctx.save();
        ctx.globalAlpha *= (1 - u) * 0.85;
        circ(ctx, ox, oy, rad, null, opts.color || pal.ACC, 6);
        circ(ctx, ox, oy, Math.max(1, rad * 0.88), null, opts.secondary || pal.GOOD, 2);
        ctx.restore();
      }
    },

    /** 5. 同空间滑轨甩镜：上一幕与下一幕在同一个世界坐标系内同步位移交棒。 */
    spatialSlide(ctx, w, h, p, dir, drawPrev, drawNext) {
      const u = E.inout(clamp(p));
      const dx = dir === 'left' ? -w : dir === 'right' ? w : 0;
      const dy = dir === 'up' ? -h : dir === 'down' ? h : 0;
      if (typeof drawPrev === 'function' && u < 0.999) {
        ctx.save();
        ctx.translate(dx * u, dy * u);
        drawPrev(1 - u);
        ctx.restore();
      }
      if (typeof drawNext === 'function' && u > 0.001) {
        ctx.save();
        ctx.translate(-dx * (1 - u), -dy * (1 - u));
        drawNext(u);
        ctx.restore();
      }
    },

    /** 6. 2.5D 卡片翻面：翻转至 90° 侧棱掠过一道高光，背面直接长出下一幕。 */
    cardFlip3D(ctx, cx, cy, w, h, p, drawFront, drawBack, opts = {}) {
      const pal = mergePalette(opts.palette);
      const u = E.inout(clamp(p));
      const angle = u * Math.PI;
      const scaleX = Math.cos(angle);
      const isBack = u >= 0.5;
      const mag = Math.max(0.03, Math.abs(scaleX));
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(mag, 1 + 0.04 * Math.sin(angle));
      ctx.translate(-cx, -cy);
      if (!isBack && typeof drawFront === 'function') drawFront(u);
      if (isBack && typeof drawBack === 'function') drawBack(u);
      // 侧棱高光
      const edgeHighlight = Math.pow(Math.max(0, 1 - Math.abs(scaleX) * 4), 2);
      if (edgeHighlight > 0.01) {
        ctx.globalAlpha *= edgeHighlight * 0.85;
        fillRR(ctx, cx - w * 0.5, cy - h * 0.5, w, h, opts.r || 28, pal.ACC);
      }
      ctx.restore();
    },
  };

  /* ------------------------------------ 高质感材质层与复杂场景组件 */

  /** 多色团弥散极光背景层：随旋律 tonal / beatPulse 缓慢流动。 */
  function drawAuroraMesh(ctx, t, opts = {}) {
    const w = opts.width || 1080;
    const h = opts.height || 1920;
    const pal = mergePalette(opts.palette);
    const pulseAmt = opts.pulse || 0;
    const blobs = opts.blobs || [
      { x: 0.25, y: 0.26, rx: 0.48, color: pal.ACC, speed: 0.35, alpha: 0.10 },
      { x: 0.78, y: 0.52, rx: 0.52, color: pal.BLUE, speed: 0.28, alpha: 0.11 },
      { x: 0.45, y: 0.78, rx: 0.46, color: pal.GOOD, speed: 0.22, alpha: 0.08 },
    ];
    ctx.save();
    for (let i = 0; i < blobs.length; i += 1) {
      const b = blobs[i];
      const cx = (b.x + 0.08 * Math.sin(t * b.speed + i * 2.1)) * w;
      const cy = (b.y + 0.06 * Math.cos(t * b.speed * 0.8 + i * 1.7)) * h;
      const rad = b.rx * Math.max(w, h) * (0.85 + 0.14 * pulseAmt);
      const grad = ctx.createRadialGradient(cx, cy, rad * 0.05, cx, cy, rad);
      grad.addColorStop(0, b.color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = (b.alpha || 0.1) * (0.8 + 0.4 * pulseAmt);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();
  }

  /** 动态透视地景线网（适合科技/AI/空间运镜底景）。 */
  function drawPerspectiveGrid(ctx, t, opts = {}) {
    const w = opts.width || 1080;
    const h = opts.height || 1920;
    const pal = mergePalette(opts.palette);
    const horizonY = opts.horizonY ?? h * 0.62;
    const bottomY = opts.bottomY ?? h;
    const col = opts.color || pal.BLUE;
    const cols = opts.cols || 10;
    const rows = opts.rows || 8;
    const speed = opts.speed ?? 0.55;
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    for (let i = -cols; i <= cols; i += 1) {
      const topX = w * 0.5 + i * (w / (cols * 2.8));
      const botX = w * 0.5 + i * (w / (cols * 0.72));
      ctx.globalAlpha = 0.16;
      line(ctx, topX, horizonY, botX, bottomY, col, 2);
    }
    const phase = (t * speed) % 1;
    for (let j = 0; j < rows; j += 1) {
      const u = ((j + phase) / rows);
      const eased = u * u;
      const y = lerp(horizonY, bottomY, eased);
      ctx.globalAlpha = 0.06 + eased * 0.22;
      line(ctx, 0, y, w, y, col, 2);
    }
    ctx.restore();
  }

  /** 玻璃拟态质感卡：带顶部高光斜角、内描边、接触抬升影与扫光脉冲。 */
  function drawGlassCard(ctx, x, y, w, h, r = 28, opts = {}) {
    const pal = mergePalette(opts.palette);
    const sweep = opts.sweep ?? -1; // 0..1 时扫过一道光泽
    ctx.save();
    ctx.shadowColor = opts.shadowColor || 'rgba(0,0,0,0.48)';
    ctx.shadowBlur = opts.shadowBlur ?? 34;
    fillRR(ctx, x, y, w, h, r, opts.fill || 'rgba(22,28,40,0.82)', opts.stroke || 'rgba(244,241,234,0.22)', opts.lw || 2.5);
    ctx.shadowBlur = 0;
    // 顶部细微内高光
    const topGrad = ctx.createLinearGradient(x, y, x, y + h * 0.45);
    topGrad.addColorStop(0, 'rgba(255,255,255,0.10)');
    topGrad.addColorStop(1, 'rgba(255,255,255,0)');
    fillRR(ctx, x + 2, y + 2, Math.max(2, w - 4), Math.max(2, h * 0.45), Math.max(4, r - 2), topGrad);
    if (sweep >= 0 && sweep <= 1) {
      const sx = lerp(x - w * 0.25, x + w * 1.1, sweep);
      const sg = ctx.createLinearGradient(sx - 90, y, sx + 90, y + h);
      sg.addColorStop(0, 'rgba(255,255,255,0)');
      sg.addColorStop(0.5, opts.sweepColor || 'rgba(255,194,75,0.22)');
      sg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.save();
      rr(ctx, x, y, w, h, r);
      if (typeof ctx.clip === 'function') ctx.clip();
      ctx.fillStyle = sg;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
    if (opts.accentBar) {
      fillRR(ctx, x + 18, y + 20, 8, Math.max(12, h - 40), 4, opts.accentColor || pal.ACC);
    }
    ctx.restore();
  }

  /** 沿三次贝塞尔曲线流动的确定性光粒流（随 onsetPulse 增亮/加速）。 */
  function drawParticleFlow(ctx, t, p0, p1, p2, p3, opts = {}) {
    const pal = mergePalette(opts.palette);
    const count = opts.count || 12;
    const col = opts.color || pal.ACC;
    const speed = opts.speed ?? 0.55;
    const pulse = opts.pulse || 0;
    ctx.save();
    if (opts.showTrack !== false && typeof ctx.bezierCurveTo === 'function') {
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
      ctx.strokeStyle = opts.trackColor || 'rgba(244,241,234,0.16)';
      ctx.lineWidth = opts.trackWidth || 3;
      ctx.stroke();
    }
    for (let i = 0; i < count; i += 1) {
      const u = (t * speed + i / count) % 1;
      const pt = Motion && typeof Motion.bezierPoint === 'function'
        ? Motion.bezierPoint(p0, p1, p2, p3, u)
        : { x: lerp(p0.x, p3.x, u), y: lerp(p0.y, p3.y, u) };
      const edgeFade = Math.sin(u * Math.PI);
      const rad = (opts.radius || 6) * (0.7 + 0.55 * pulse) * (0.5 + 0.5 * edgeFade);
      ctx.globalAlpha = clamp(edgeFade * (0.55 + 0.45 * pulse));
      ctx.shadowColor = col;
      ctx.shadowBlur = 16;
      circ(ctx, pt.x, pt.y, rad, col);
    }
    ctx.restore();
  }

  /** 动作因果演员：鼠标指针 + 点击压缩 + 因果涟漪（替代元素无因蹦出）。 */
  function drawCursorClick(ctx, x, y, clickP, opts = {}) {
    const pal = mergePalette(opts.palette);
    const p = clamp(clickP);
    const press = p > 0 && p < 0.35 ? Math.sin((p / 0.35) * Math.PI) : 0;
    const scale = 1 - press * 0.22;
    ctx.save();
    if (p > 0.12 && p < 1) {
      const rip = clamp((p - 0.12) / 0.88);
      ctx.save();
      ctx.globalAlpha *= (1 - rip) * 0.85;
      circ(ctx, x, y, 16 + rip * (opts.rippleRadius || 96), null, opts.rippleColor || pal.ACC, 4);
      ctx.restore();
    }
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 42);
    ctx.lineTo(12, 32);
    ctx.lineTo(22, 50);
    ctx.lineTo(29, 46);
    ctx.lineTo(19, 28);
    ctx.lineTo(33, 27);
    ctx.closePath();
    ctx.fillStyle = opts.fill || '#ffffff';
    ctx.fill();
    ctx.strokeStyle = opts.stroke || '#0a0c10';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 对话交锋剧场：多轮人物/评论气泡错落登场，后句反驳时前句自动退暗微倾，
   * 配合高光描边与因果触发，专攻“有一段对话/访谈/辩论”的场景。
   */
  function drawDialogueTheater(ctx, t, turns, opts = {}) {
    const pal = mergePalette(opts.palette);
    const list = Array.isArray(turns) ? turns : [];
    const x = opts.x ?? 94;
    const width = opts.width ?? 892;
    const gap = opts.gap ?? 34;
    let cursorY = opts.y ?? 340;
    for (let i = 0; i < list.length; i += 1) {
      const turn = list[i];
      const start = turn.at ?? i * 1.4;
      const enterP = P(t, start, start + 0.42, E.back);
      const h = turn.height ?? 210;
      if (enterP > 0) {
        const nextTurn = list[i + 1];
        const dimP = nextTurn && turn.dimOnNext !== false
          ? P(t, nextTurn.at ?? (i + 1) * 1.4, (nextTurn.at ?? (i + 1) * 1.4) + 0.35)
          : 0;
        const alignRight = turn.side === 'right';
        const cardW = turn.width ?? Math.round(width * 0.86);
        const cardX = alignRight ? x + width - cardW : x;
        const tone = turn.tone === 'bad' ? pal.BAD : turn.tone === 'good' ? pal.GOOD : turn.tone === 'paper' ? pal.PAPER : pal.CARD;
        const isLight = turn.tone === 'paper';
        const stroke = turn.tone === 'bad' ? pal.BAD : turn.tone === 'good' ? pal.GOOD : 'rgba(244,241,234,0.22)';
        const sh = turn.slam ? (Motion && typeof Motion.shake === 'function' ? Motion.shake(t, start, { amp: 8 }) : 0) : 0;

        ctx.save();
        ctx.globalAlpha *= clamp(enterP * 2.4) * lerp(1, 0.46, dimP);
        ctx.translate(cardX + cardW * 0.5 + sh, cursorY + h * 0.5 + (1 - enterP) * 90 - dimP * 14);
        const sc = lerp(turn.slam ? 1.16 : 0.94, 1, clamp(enterP)) * lerp(1, 0.94, dimP);
        ctx.scale(sc, sc);
        if (typeof ctx.rotate === 'function') ctx.rotate(lerp(alignRight ? 0.025 : -0.025, dimP * (alignRight ? 0.015 : -0.015), clamp(enterP)));
        fillRR(ctx, -cardW * 0.5, -h * 0.5, cardW, h, 30, isLight ? pal.PAPER : pal.CARD, stroke, turn.tone ? 4 : 2.5);
        const padX = -cardW * 0.5 + 42;
        if (turn.speaker) {
          drawText(ctx, turn.speaker, padX, -h * 0.5 + 52, 28, {
            w: 700,
            col: isLight ? '#6b7280' : (turn.tone === 'bad' ? pal.BAD : turn.tone === 'good' ? pal.GOOD : pal.ACC),
          });
        }
        drawText(ctx, turn.line1 || '', padX, -h * 0.5 + 122, turn.size || 46, {
          w: 800,
          col: isLight ? '#15171c' : pal.INK,
        });
        if (turn.line2) {
          drawText(ctx, turn.line2, padX, -h * 0.5 + 188, turn.size2 || 38, {
            w: 700,
            col: isLight ? '#374151' : (turn.accentColor || pal.ACC),
          });
        }
        ctx.restore();
      }
      cursorY += h + gap;
    }
    return cursorY;
  }

  /** 基于实测拍点/起音的确定性声纹频谱柱（无声音时不伪造跳动）。 */
  function drawAudioSpectrum(ctx, t, rhythm, opts = {}) {
    const pal = mergePalette(opts.palette);
    const x = opts.x ?? 140;
    const y = opts.y ?? 1400;
    const width = opts.width ?? 800;
    const maxH = opts.height ?? 110;
    const bars = opts.bars ?? 28;
    const r = rhythm || readRhythm(60, 112);
    const bp = hitPulse(r.beats, t, 0.22, r.beatStrength);
    const op = hitPulse(r.onsets, t, 0.14, r.onsetStrength);
    const tp = hitPulse(r.tonal || [], t, 0.28);
    const activeEnergy = clamp(bp * 0.65 + op * 0.55 + tp * 0.45);
    const gap = opts.gap ?? 8;
    const bw = (width - (bars - 1) * gap) / bars;

    ctx.save();
    for (let i = 0; i < bars; i += 1) {
      const norm = i / Math.max(1, bars - 1);
      const bell = Math.sin(norm * Math.PI);
      const bandPhase = 0.5 + 0.5 * Math.sin(t * (7 + (i % 5) * 2.3) + i * 0.9);
      const amp = activeEnergy <= 0.02
        ? 0.04
        : clamp(0.08 + activeEnergy * (0.45 + 0.55 * bandPhase) * (0.45 + 0.55 * bell));
      const bh = Math.max(6, amp * maxH);
      const bx = x + i * (bw + gap);
      const by = y + (maxH - bh) * 0.5;
      const col = i % 3 === 0 ? (opts.accentColor || pal.ACC) : (opts.color || pal.GOOD);
      ctx.globalAlpha = 0.35 + 0.65 * amp;
      fillRR(ctx, bx, by, bw, bh, bw * 0.5, col);
    }
    ctx.restore();
  }

  /**
   * 首尾帧图文协同舞台：把上传/生成的起/中/终关键帧图片与遮罩转场、
   * 推镜放大、发光框标与引线标注融合渲染（未加载完成时有优雅占位）。
   */
  function drawImageAnchorStage(ctx, t, frames, opts = {}) {
    const pal = mergePalette(opts.palette);
    const list = Array.isArray(frames) ? frames : [];
    if (!list.length) return;
    const x = opts.x ?? 94;
    const y = opts.y ?? 340;
    const w = opts.width ?? 892;
    const h = opts.height ?? 980;
    const radius = opts.radius ?? 32;

    let idx = 0;
    for (let i = 1; i < list.length; i += 1) {
      if (t >= (list[i].at ?? i * 2.5)) idx = i;
    }
    const cur = list[idx];
    const prev = idx > 0 ? list[idx - 1] : null;
    const localP = prev ? P(t, cur.at ?? idx * 2.5, (cur.at ?? idx * 2.5) + (cur.transitionDur || 0.75), E.inout) : 1;

    const drawOne = (item, zoomProgress, alpha = 1) => {
      ctx.save();
      ctx.globalAlpha *= alpha;
      rr(ctx, x, y, w, h, radius);
      if (typeof ctx.clip === 'function') ctx.clip();
      const zoom = lerp(item.zoomFrom ?? 1.0, item.zoomTo ?? 1.12, clamp(zoomProgress));
      ctx.translate(x + w * 0.5, y + h * 0.5);
      ctx.scale(zoom, zoom);
      ctx.translate(-(x + w * 0.5), -(y + h * 0.5));
      if (item.img && typeof ctx.drawImage === 'function' && (item.img.complete === undefined || item.img.complete)) {
        ctx.drawImage(item.img, x, y, w, h);
      } else {
        fillRR(ctx, x, y, w, h, radius, pal.CARD, pal.ACC, 3);
        drawText(ctx, item.label || '关键帧锚点', x + w * 0.5, y + h * 0.5, 44, { al: 'center', col: pal.INK });
      }
      ctx.restore();
    };

    if (prev && localP < 1) {
      drawOne(prev, 1, 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w * localP, h);
      if (typeof ctx.clip === 'function') ctx.clip();
      drawOne(cur, localP, 1);
      ctx.restore();
      line(ctx, x + w * localP, y, x + w * localP, y + h, opts.dividerColor || pal.ACC, 6);
    } else {
      const segDur = (list[idx + 1]?.at ?? (cur.at || 0) + 3) - (cur.at || 0);
      const zP = clamp((t - (cur.at || 0)) / Math.max(0.5, segDur));
      drawOne(cur, zP, 1);
    }

    drawGlassCard(ctx, x, y, w, h, radius, { fill: 'rgba(0,0,0,0)', stroke: opts.frameStroke || 'rgba(255,194,75,0.45)', lw: 4, shadowBlur: 24 });
    if (cur.label) {
      drawTag(ctx, cur.label, x + 28, y + h - 40, t, cur.at || 0, opts.tagColor || pal.ACC);
    }
  }

  /** 多源贝塞尔汇聚因果链（n 个输入节点沿弧线汇入右/下方核心枢纽）。 */
  function drawFlowNodes(ctx, t, nodes, target, opts = {}) {
    const pal = mergePalette(opts.palette);
    const list = Array.isArray(nodes) ? nodes : [];
    const tgt = target || { x: 820, y: 920, label: '核心结果' };
    const start = opts.start ?? 0;
    const pulse = opts.pulse || 0;
    list.forEach((node, i) => {
      const p = P(t, start + i * 0.14, start + i * 0.14 + 0.55, E.back);
      if (p <= 0) return;
      const p0 = { x: node.x, y: node.y };
      const p1 = { x: lerp(node.x, tgt.x, 0.45), y: node.y };
      const p2 = { x: lerp(node.x, tgt.x, 0.55), y: tgt.y };
      const p3 = { x: tgt.x, y: tgt.y };
      drawParticleFlow(ctx, Math.max(0, t - start), p0, p1, p2, p3, {
        palette: pal,
        count: 5,
        color: node.color || pal.ACC,
        pulse,
        trackColor: 'rgba(244,241,234,0.2)',
      });
      ctx.save();
      ctx.globalAlpha *= clamp(p * 2);
      ctx.translate(node.x, node.y);
      ctx.scale(p, p);
      fillRR(ctx, -110, -40, 220, 80, 24, pal.CARD, node.color || pal.BLUE, 3);
      drawText(ctx, node.label || `源 ${i + 1}`, 0, 12, 30, { w: 700, col: pal.INK, al: 'center' });
      ctx.restore();
    });
    const hubP = P(t, start + 0.4, start + 1.0, E.back);
    if (hubP > 0) {
      ctx.save();
      ctx.translate(tgt.x, tgt.y);
      ctx.scale(hubP * (1 + 0.06 * pulse), hubP * (1 + 0.06 * pulse));
      ctx.shadowColor = pal.GOOD;
      ctx.shadowBlur = 32;
      circ(ctx, 0, 0, opts.hubRadius || 68, pal.CARD, pal.GOOD, 5);
      drawText(ctx, tgt.label || '输出', 0, 12, 34, { w: 900, col: pal.GOOD, al: 'center' });
      ctx.restore();
    }
  }

  /** 前后对比拉杆组件。 */
  function drawCompareSlider(ctx, t, opts = {}) {
    const pal = mergePalette(opts.palette);
    const x = opts.x ?? 94;
    const y = opts.y ?? 580;
    const w = opts.width ?? 892;
    const h = opts.height ?? 420;
    const pos = clamp(opts.pos ?? (0.5 + 0.38 * Math.sin(t * 1.8)));
    const splitX = x + w * pos;

    drawGlassCard(ctx, x, y, w, h, 28, { palette: pal, fill: pal.CARD });
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, splitX - x, h);
    if (typeof ctx.clip === 'function') ctx.clip();
    fillRR(ctx, x, y, w, h, 28, 'rgba(255,92,92,0.14)', pal.BAD, 3);
    drawText(ctx, opts.beforeLabel || '改造前', x + w * 0.25, y + h * 0.46, 46, { w: 800, col: pal.BAD, al: 'center' });
    if (opts.beforeValue) drawText(ctx, opts.beforeValue, x + w * 0.25, y + h * 0.66, 68, { w: 900, col: pal.INK, al: 'center' });
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(splitX, y, x + w - splitX, h);
    if (typeof ctx.clip === 'function') ctx.clip();
    fillRR(ctx, x, y, w, h, 28, 'rgba(79,240,176,0.14)', pal.GOOD, 3);
    drawText(ctx, opts.afterLabel || '改造后', x + w * 0.75, y + h * 0.46, 46, { w: 800, col: pal.GOOD, al: 'center' });
    if (opts.afterValue) drawText(ctx, opts.afterValue, x + w * 0.75, y + h * 0.66, 68, { w: 900, col: pal.GOOD, al: 'center' });
    ctx.restore();

    line(ctx, splitX, y - 16, splitX, y + h + 16, pal.ACC, 6);
    circ(ctx, splitX, y + h * 0.5, 22, pal.ACC, pal.BG, 4);
  }

  /** 满弧扫针仪表盘组件。 */
  function drawRadialGauge(ctx, t, opts = {}) {
    const pal = mergePalette(opts.palette);
    const cx = opts.cx ?? 540;
    const cy = opts.cy ?? 960;
    const rad = opts.radius ?? 220;
    const value = clamp(opts.value ?? 0.85);
    const startA = Math.PI * 0.8;
    const sweepA = Math.PI * 1.4;
    const curA = startA + sweepA * value;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rad, startA, startA + sweepA);
    ctx.strokeStyle = 'rgba(244,241,234,0.16)';
    ctx.lineWidth = 24;
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, rad, startA, curA);
    ctx.strokeStyle = opts.color || pal.GOOD;
    ctx.lineWidth = 24;
    ctx.lineCap = 'round';
    ctx.shadowColor = opts.color || pal.GOOD;
    ctx.shadowBlur = 24;
    ctx.stroke();
    ctx.shadowBlur = 0;

    const nx = cx + Math.cos(curA) * (rad - 36);
    const ny = cy + Math.sin(curA) * (rad - 36);
    line(ctx, cx, cy, nx, ny, pal.ACC, 10);
    circ(ctx, cx, cy, 18, pal.ACC);
    drawText(ctx, opts.displayValue || `${Math.round(value * 100)}%`, cx, cy + 95, 72, { w: 900, col: pal.INK, al: 'center' });
    if (opts.label) drawText(ctx, opts.label, cx, cy + 150, 34, { w: 700, col: pal.DIM, al: 'center' });
    ctx.restore();
  }

  return {
    DEFAULT_PALETTE,
    FONT_STACK,
    clamp,
    lerp,
    E,
    P,
    mergePalette,
    safeArea,
    readRhythm,
    lastAt,
    hitPulse,
    steps,
    det,
    createStage,
    setFont,
    rr,
    fillRR,
    line,
    circ,
    drawCheck,
    drawXMark,
    drawText,
    drawSegments,
    drawRiseText,
    drawSlamText,
    drawUnderline,
    drawTag,
    drawBigNum,
    blk,
    drawBackdrop,
    drawChrome,
    drawWipeBand,
    withCamera,
    withParallax,
    grow,
    drawAuroraMesh,
    drawPerspectiveGrid,
    drawGlassCard,
    drawParticleFlow,
    drawCursorClick,
    drawDialogueTheater,
    drawAudioSpectrum,
    drawImageAnchorStage,
    drawFlowNodes,
    drawCompareSlider,
    drawRadialGauge,
    drawScale,
    drawDoors,
    drawSplitBar,
    drawRunway,
    drawSimGrid,
    drawChecklistRow,
  };
});
