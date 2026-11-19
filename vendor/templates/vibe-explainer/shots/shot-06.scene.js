function drawShot({ t, duration, ctx, w, h, safe, pal, copy, kit }) {
  kit.drawRiseText(ctx, copy.headline || '把 96 次错，留在动手之前', safe.cx, 410, 62, t, 0.15, {
    al: 'center',
    w: 800,
    col: pal.INK,
  });

  // Deterministic 96-cell grid schedule over [0.45, 2.75]
  const total = 96;
  const times = [];
  const order = [];
  const used = new Array(total).fill(false);
  for (let i = 0; i < total; i += 1) {
    times.push(0.45 + (i / total) * 2.25);
    let idx = Math.floor(kit.det(i, 7, 19) * total);
    while (used[idx]) idx = (idx + 1) % total;
    used[idx] = true;
    order.push(idx);
  }

  const collapse = kit.P(t, 3.0, 3.9, kit.E.inout);
  const shown = kit.drawSimGrid(ctx, {
    palette: pal,
    x: 112,
    y: 590,
    cell: 64,
    gap: 8,
    cols: 12,
    rows: 8,
    times,
    order,
    keepIndex: 41,
    collapse,
    t,
    targetX: safe.cx,
    targetY: 920,
  });

  // Winning emerald node emerges cleanly at center as grid collapses
  const winP = kit.P(t, 3.25, 4.15, kit.E.back);
  if (winP > 0) {
    ctx.save();
    ctx.translate(safe.cx, 920);
    ctx.scale(winP, winP);
    ctx.shadowColor = pal.GOOD;
    ctx.shadowBlur = 40;
    kit.circ(ctx, 0, 0, 96, 'rgba(79,240,176,0.18)', pal.GOOD, 6);
    ctx.shadowBlur = 0;
    kit.drawCheck(ctx, 0, 4, 92, kit.P(t, 3.45, 4.15), pal.GOOD, 14);
    ctx.restore();
  }

  // Live simulation counter / summary card
  const summaryText = collapse > 0.6
    ? '真实世界：1 次命中 · 沙盘推演：96 次排雷'
    : `已完成低成本预演：${shown} / 96 次边界测试`;
  kit.fillRR(ctx, safe.left + 30, 1290, safe.span - 60, 140, 26, pal.CARD, collapse > 0.6 ? pal.GOOD : pal.ACC, 3);
  kit.drawText(ctx, summaryText, safe.cx, 1372, 36, {
    w: 700,
    col: collapse > 0.6 ? pal.GOOD : pal.ACC,
    al: 'center',
  });

  kit.drawWipeBand(ctx, t, duration, { width: w, height: h, palette: pal });
}
