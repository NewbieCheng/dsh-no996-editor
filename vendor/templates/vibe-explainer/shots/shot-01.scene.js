function drawShot({ t, duration, ctx, w, h, safe, pal, copy, kit, motion }) {
  const shakeX = motion.shake(t, 1.15, { amp: 14, freq: 90, decay: 14 });
  ctx.save();
  ctx.translate(shakeX, shakeX * 0.35);

  // Subtle ambient energy rings anchored around the slam point
  const ringP = kit.P(t, 1.15, 2.3, kit.E.out5);
  if (ringP > 0 && ringP < 1) {
    ctx.save();
    ctx.globalAlpha *= (1 - ringP) * 0.55;
    kit.circ(ctx, safe.cx, 1020, 60 + ringP * 380, null, pal.BAD, 4);
    ctx.restore();
  }

  // Opening tag pill
  kit.drawTag(ctx, copy.tag || '为什么越焦虑，越不敢动手？', safe.left, 360, t, 0.25, pal.ACC);

  // Staggered kinetic typography
  kit.drawRiseText(ctx, copy.lead1 || '你以为你在害怕失败', safe.cx, 620, 64, t, 0.45, {
    al: 'center',
    w: 700,
    col: pal.INK,
  });

  kit.drawRiseText(ctx, copy.lead2 || '其实你只是害怕——', safe.cx, 740, 56, t, 0.78, {
    al: 'center',
    w: 600,
    col: pal.DIM,
  });

  // Heavy kinetic slam impact aligned to beat hit
  kit.drawSlamText(ctx, copy.slam || '一次输光', safe.cx, 1060, 128, t, 1.15, {
    al: 'center',
    w: 900,
    col: pal.BAD,
    sh: 'rgba(255,92,92,0.55)',
    shb: 38,
    fromScale: 1.55,
  });

  kit.drawUnderline(ctx, safe.cx - 260, safe.cx + 260, 1110, t, 1.38, 0.42, pal.BAD, 10);

  // Reframe card rising in second half
  const cardP = kit.P(t, 2.25, 2.95, kit.E.back);
  if (cardP > 0) {
    ctx.save();
    ctx.globalAlpha *= Math.min(1, cardP * 2);
    ctx.translate(0, (1 - cardP) * 90);
    kit.fillRR(ctx, safe.left + 20, 1240, safe.span - 40, 210, 28, pal.CARD, 'rgba(255,194,75,0.45)', 3);
    kit.drawText(ctx, '高手的底气，从来不是每次都对', safe.cx, 1330, 42, { w: 700, col: pal.INK, al: 'center' });
    kit.drawText(ctx, '而是把「错的代价」打成白菜价', safe.cx, 1400, 38, { w: 800, col: pal.ACC, al: 'center' });
    ctx.restore();
  }

  ctx.restore();
  kit.drawWipeBand(ctx, t, duration, { width: w, height: h, palette: pal });
}
