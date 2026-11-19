function drawShot({ t, duration, ctx, w, h, safe, pal, copy, kit, motion }) {
  const crackShake = motion.shake(t, 1.55, { amp: 12, freq: 85, decay: 16 });
  ctx.save();
  ctx.translate(crackShake, crackShake * 0.4);

  kit.drawBigNum(ctx, copy.num || '02', t, 0.05, pal.ACC, safe.left - 10, 465);

  kit.drawRiseText(ctx, copy.headline || '哪怕真的是单向门，也要学会拆碎', safe.cx, 560, 52, t, 0.2, {
    al: 'center',
    w: 800,
    col: pal.INK,
  });

  const enter = kit.P(t, 0.25, 0.85, kit.E.out);
  const split = kit.P(t, 1.5, 2.3, kit.E.out);
  const fall = kit.P(t, 2.55, 3.6, kit.E.inn);
  const pick = kit.P(t, 3.55, 4.45, kit.E.back);

  kit.drawSplitBar(ctx, {
    palette: pal,
    x: safe.left,
    y: 670,
    width: safe.span,
    height: 180,
    count: 6,
    enter,
    split,
    fall,
    pick,
    wholeText: copy.whole || '3 个月 · 整个方向 · 一次押满',
    focusText: copy.focus || '先只做这 1 块 · 2 周验证',
    pieceText: '2周',
  });

  // Dashed stop-loss cutoff line animating beneath
  const lineP = kit.P(t, 2.9, 3.8, kit.E.out);
  if (lineP > 0) {
    ctx.save();
    ctx.globalAlpha *= lineP;
    ctx.setLineDash([18, 12]);
    kit.line(ctx, safe.left, 1080, kit.lerp(safe.left, safe.right, lineP), 1080, pal.ACC, 4);
    ctx.setLineDash([]);
    kit.drawText(ctx, '▲ 止损线：哪怕验证失败，也只赔掉 16% 时间', safe.cx, 1145, 34, {
      w: 700,
      col: pal.ACC,
      al: 'center',
    });
    ctx.restore();
  }

  ctx.restore();
  kit.drawWipeBand(ctx, t, duration, { width: w, height: h, palette: pal });
}
