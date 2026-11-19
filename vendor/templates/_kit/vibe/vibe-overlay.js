/*
 * VibeOverlay (`window.VibeOverlay`): 口播 / 实拍视频透明叠加层组件库。
 *
 * 专用于放在 `<video>` 主轨上方的透明 `<iframe>` 轨道，只绘制局部金句、胶囊要点、
 * 数据对比、步骤进度与重点标注，默认避让人物头部（支持传入 `vision` 人脸框 `avoidRect`）
 * 和底部字幕安全区。全部状态为仅依赖 `t` 的闭式纯函数。
 */
(function (root, factory) {
  const api = factory();
  root.VibeOverlay = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const out3 = p => 1 - Math.pow(1 - clamp(p), 3);
  const backOut = p => {
    const s = 1.65;
    const u = clamp(p) - 1;
    return 1 + (s + 1) * u * u * u + s * u * u;
  };
  const seg = (t, a, d = 0.38) => clamp((t - a) / Math.max(d, 1e-4));

  const FONT = '"PingFang SC","Microsoft YaHei UI","Microsoft YaHei","Noto Sans SC",sans-serif';

  /** 根据画幅与可选人脸避让区计算推荐叠加槽位（top-banner / lower-card / side-rail）。 */
  function safeAnchor(w, h, avoidRect) {
    const portrait = h >= w;
    if (!avoidRect) {
      return portrait
        ? { x: 72, y: 180, width: w - 144, cardY: h * 0.62 }
        : { x: 96, y: 120, width: Math.min(820, w * 0.45), cardY: h * 0.56 };
    }
    // If face occupies upper center, push overlay card safely below face box (above subtitle band).
    const faceBottom = Number(avoidRect.bottom ?? 0) * h;
    const safeTop = Math.min(h - 360, Math.max(portrait ? 160 : 96, faceBottom > h * 0.52 ? 140 : faceBottom + 44));
    return {
      x: portrait ? 72 : (Number(avoidRect.right ?? 0) < 0.52 ? Math.round(w * 0.52) : 96),
      y: Math.round(safeTop),
      width: portrait ? w - 144 : Math.min(780, Math.round(w * 0.42)),
      cardY: Math.round(safeTop),
    };
  }

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  /** 1. 透明底金句砸入短卡（含入场准备与出场淡收）。 */
  function heroCallout(ctx, t, opts = {}) {
    const start = opts.start ?? 0.1;
    const end = opts.end ?? 3.5;
    if (t < start || t > end) return;
    const pin = seg(t, start, 0.34);
    const pout = seg(t, end - 0.25, 0.25);
    const alpha = clamp(pin * 3) * (1 - out3(pout));
    const scale = lerp(1.22, 1, out3(pin));
    const x = opts.x ?? 72;
    const y = opts.y ?? 200;
    const w = opts.width ?? 936;
    const h = opts.height ?? 190;
    const accent = opts.accent || '#ffc24b';

    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x + w / 2, y + h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-w / 2, -h / 2);
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = 32;
    rr(ctx, 0, 0, w, h, 26);
    ctx.fillStyle = opts.bg || 'rgba(14,17,24,.88)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = accent;
    ctx.stroke();
    ctx.shadowBlur = 0;

    rr(ctx, 0, 24, 8, h - 48, 4);
    ctx.fillStyle = accent;
    ctx.fill();

    if (opts.kicker) {
      ctx.font = `700 26px ${FONT}`;
      ctx.fillStyle = accent;
      ctx.fillText(opts.kicker, 36, 60);
    }
    ctx.font = `800 ${opts.size ?? 54}px ${FONT}`;
    ctx.fillStyle = opts.color || '#f4f1ea';
    ctx.fillText(opts.title || '', 36, opts.kicker ? 132 : 114);
    ctx.restore();
  }

  /** 2. 错峰痛点/要点胶囊排。 */
  function pillStagger(ctx, t, items = [], opts = {}) {
    const start = opts.start ?? 0.2;
    const step = opts.step ?? 0.25;
    const end = opts.end ?? 5.0;
    if (t < start || t > end) return;
    const pout = 1 - out3(seg(t, end - 0.24, 0.24));
    const x0 = opts.x ?? 72;
    const y0 = opts.y ?? 1260;
    const accent = opts.accent || '#ff5c5c';

    items.forEach((label, i) => {
      const u = seg(t, start + i * step, 0.3);
      if (u <= 0) return;
      const sc = lerp(1.25, 1, backOut(u));
      ctx.save();
      ctx.globalAlpha *= clamp(u * 3) * pout;
      ctx.font = `700 34px ${FONT}`;
      const bw = ctx.measureText(label).width + 64;
      const by = y0 + i * 82;
      ctx.translate(x0 + bw / 2, by + 32);
      ctx.scale(sc, sc);
      rr(ctx, -bw / 2, -32, bw, 64, 32);
      ctx.fillStyle = 'rgba(16,19,26,.88)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = accent;
      ctx.stroke();
      ctx.fillStyle = '#f4f1ea';
      ctx.textAlign = 'center';
      ctx.fillText(label, 0, 12);
      ctx.restore();
    });
  }

  /** 3. 数据/指标对比浮窗。 */
  function metricCompare(ctx, t, opts = {}) {
    const start = opts.start ?? 0.2;
    const end = opts.end ?? 4.5;
    if (t < start || t > end) return;
    const u = out3(seg(t, start, 0.45));
    const pout = 1 - out3(seg(t, end - 0.24, 0.24));
    const x = opts.x ?? 72;
    const y = opts.y ?? 1120;
    const w = opts.width ?? 936;
    const val = lerp(opts.from ?? 0, opts.to ?? 100, u);

    ctx.save();
    ctx.globalAlpha *= clamp(u * 2.5) * pout;
    rr(ctx, x, y, w, 170, 24);
    ctx.fillStyle = 'rgba(14,17,24,.9)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(244,241,234,.22)';
    ctx.stroke();
    ctx.font = `700 30px ${FONT}`;
    ctx.fillStyle = '#8d94a1';
    ctx.fillText(opts.label || '关键指标', x + 32, y + 58);
    ctx.font = `900 68px ${FONT}`;
    ctx.fillStyle = opts.accent || '#4ff0b0';
    ctx.fillText(`${opts.prefix || ''}${Math.round(val)}${opts.suffix || ''}`, x + 32, y + 132);
    const barX = x + 360;
    const barW = Math.max(120, w - 400);
    rr(ctx, barX, y + 72, barW, 28, 14);
    ctx.fillStyle = 'rgba(255,255,255,.1)';
    ctx.fill();
    rr(ctx, barX, y + 72, barW * clamp(val / Math.max(1, opts.max ?? opts.to ?? 100)), 28, 14);
    ctx.fillStyle = opts.accent || '#4ff0b0';
    ctx.fill();
    ctx.restore();
  }

  /** 4. 顶部步骤进度轨。 */
  function stepRail(ctx, t, steps = [], activeIndex = 0, opts = {}) {
    const start = opts.start ?? 0;
    const end = opts.end ?? 10;
    if (t < start || t > end || !steps.length) return;
    const alpha = out3(seg(t, start, 0.3));
    const x0 = opts.x ?? 72;
    const y0 = opts.y ?? 88;
    const w = opts.width ?? 936;
    const gap = 12;
    const segW = (w - gap * (steps.length - 1)) / steps.length;
    ctx.save();
    ctx.globalAlpha *= alpha;
    steps.forEach((name, i) => {
      const sx = x0 + i * (segW + gap);
      const active = i === activeIndex;
      rr(ctx, sx, y0, segW, 10, 5);
      ctx.fillStyle = active ? (opts.accent || '#ffc24b') : 'rgba(244,241,234,.25)';
      ctx.fill();
      ctx.font = `${active ? 800 : 600} 26px ${FONT}`;
      ctx.fillStyle = active ? '#f4f1ea' : 'rgba(244,241,234,.62)';
      ctx.fillText(name, sx, y0 + 44);
    });
    ctx.restore();
  }

  /** 5. 局部荧光下划线与框选圈注。 */
  function focusHighlight(ctx, t, rect, opts = {}) {
    const start = opts.start ?? 0.2;
    const end = opts.end ?? 3.0;
    if (!rect || t < start || t > end) return;
    const p = out3(seg(t, start, 0.35));
    const pout = 1 - out3(seg(t, end - 0.2, 0.2));
    ctx.save();
    ctx.globalAlpha *= pout;
    ctx.strokeStyle = opts.color || '#ffc24b';
    ctx.lineWidth = opts.lineWidth || 6;
    const perimeter = 2 * (rect.w + rect.h);
    ctx.setLineDash([perimeter * p, perimeter]);
    rr(ctx, rect.x, rect.y, rect.w, rect.h, opts.radius ?? 14);
    ctx.stroke();
    ctx.restore();
  }

  return {
    safeAnchor,
    heroCallout,
    pillStagger,
    metricCompare,
    stepRail,
    focusHighlight,
  };
});
