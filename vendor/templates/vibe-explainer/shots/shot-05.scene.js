function drawShot({ t, duration, ctx, w, h, safe, pal, copy, kit }) {
  kit.drawBigNum(ctx, copy.num || '03', t, 0.05, pal.ACC, safe.left - 10, 475);

  kit.drawRiseText(ctx, copy.headline || '压垮你的不是难度，是跑道太短', safe.cx, 575, 52, t, 0.2, {
    al: 'center',
    w: 800,
    col: pal.INK,
  });

  // First 3 blocks burn out into red danger (0.8..2.3s), then backup capacity pops in (2.5..4.2s)
  const burnRates = [
    kit.P(t, 0.85, 1.45, kit.E.out),
    kit.P(t, 1.35, 1.95, kit.E.out),
    kit.P(t, 1.85, 2.45, kit.E.out) * 0.65,
  ];
  const added = [];
  for (let j = 0; j < 9; j += 1) {
    const startT = 2.6 + j * 0.14;
    added.push(kit.P(t, startT, startT + 0.35, kit.E.back));
  }

  kit.drawRunway(ctx, {
    palette: pal,
    x: safe.left + 8,
    y: 800,
    cellWidth: 66,
    gap: 8,
    total: 12,
    baseFilled: 3,
    burnRates,
    added,
    alpha: kit.P(t, 0.2, 0.65),
  });

  // Status counter turning from warning to ×4.0 runway
  const flipP = kit.P(t, 2.55, 3.2, kit.E.out);
  const label = flipP < 0.5 ? '仅剩 3 个月缓冲 · 容错危机' : '主业现金流 + 备用金 → ×4.0 跑道';
  const col = flipP < 0.5 ? pal.BAD : pal.GOOD;
  kit.fillRR(ctx, safe.left + 40, 1080, safe.span - 80, 150, 28, pal.CARD, col, 3);
  kit.drawText(ctx, label, safe.cx, 1170, 38, { w: 800, col, al: 'center' });

  const subP = kit.P(t, 3.3, 4.0, kit.E.out);
  if (subP > 0) {
    kit.drawText(ctx, '给每一次新尝试留足时间冗余，焦虑自然退潮', safe.cx, 1340, 34, {
      w: 600,
      col: pal.DIM,
      al: 'center',
      a: subP,
    });
  }

  kit.drawWipeBand(ctx, t, duration, { width: w, height: h, palette: pal });
}
