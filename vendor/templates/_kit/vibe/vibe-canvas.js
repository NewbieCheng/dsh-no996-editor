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
    drawScale,
    drawDoors,
    drawSplitBar,
    drawRunway,
    drawSimGrid,
    drawChecklistRow,
  };
});
