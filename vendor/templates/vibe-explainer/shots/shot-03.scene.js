function drawShot({ t, duration, ctx, w, h, safe, pal, copy, kit }) {
  kit.drawRiseText(ctx, copy.headline || '先分清：这是哪一扇门？', safe.cx, 410, 62, t, 0.15, {
    al: 'center',
    w: 800,
    col: pal.INK,
  });

  // Labels above doors
  const lblP = kit.P(t, 0.35, 0.85, kit.E.out);
  kit.drawText(ctx, copy.leftTitle || '单向门 · 不可逆', 300, 560, 34, { w: 700, col: pal.BAD, al: 'center', a: lblP });
  kit.drawText(ctx, copy.rightTitle || '双向门 · 随时撤退', 780, 560, 34, { w: 700, col: pal.GOOD, al: 'center', a: lblP });

  // Left door locks shut at t=1.35 while actor ball hits and bounces back
  const leftClosed = kit.P(t, 1.0, 1.45, kit.E.out);
  const leftHit = kit.P(t, 0.6, 1.4, kit.E.out);
  const leftRebound = kit.P(t, 1.4, 2.3, kit.E.out);
  const actorLeftX = leftHit < 1 ? kit.lerp(130, 260, leftHit) : kit.lerp(260, 155, leftRebound);

  // Right door stays responsive: opens and actor glides cleanly through & returns
  const rightPass = kit.P(t, 2.4, 3.8, kit.E.inout);
  const rightBack = kit.P(t, 4.0, 5.1, kit.E.inout);
  const rightClosed = Math.max(0, 0.5 - kit.P(t, 2.1, 2.8, kit.E.out) * 0.5);
  const actorRightX = t < 3.9 ? kit.lerp(620, 910, rightPass) : kit.lerp(910, 660, rightBack);

  kit.drawDoors(ctx, {
    palette: pal,
    cy: 900,
    leftX: 300,
    rightX: 780,
    leftClosed,
    rightClosed,
    actorLeftX,
    actorRightX,
    alpha: kit.P(t, 0.15, 0.65),
  });

  // Rule banner in second half
  const tipP = kit.P(t, 3.0, 3.65, kit.E.back);
  if (tipP > 0) {
    ctx.save();
    ctx.globalAlpha *= Math.min(1, tipP * 2);
    ctx.translate(0, (1 - tipP) * 60);
    kit.fillRR(ctx, safe.left + 20, 1300, safe.span - 40, 190, 28, pal.CARD, 'rgba(79,240,176,0.45)', 3);
    kit.drawText(ctx, '90% 的焦虑，都在把「双向门」当成「单向门」', safe.cx, 1385, 36, { w: 700, col: pal.INK, al: 'center' });
    kit.drawText(ctx, '可逆的决定，先跨半步再说', safe.cx, 1448, 34, { w: 700, col: pal.GOOD, al: 'center' });
    ctx.restore();
  }

  kit.drawWipeBand(ctx, t, duration, { width: w, height: h, palette: pal });
}
