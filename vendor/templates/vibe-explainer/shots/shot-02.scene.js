function drawShot({ t, duration, ctx, w, h, safe, pal, copy, kit }) {
  kit.drawBigNum(ctx, copy.num || '01', t, 0.05, pal.ACC, safe.left - 10, 490);

  kit.drawRiseText(ctx, copy.headline || '试错成本越低，容错率越暴涨', safe.cx, 585, 58, t, 0.25, {
    al: 'center',
    w: 800,
    col: pal.INK,
  });

  // Dynamic lever scale shifting cost from 1.0 down to 0.18
  const shiftP = kit.P(t, 1.1, 3.3, kit.E.inout);
  const cost = kit.lerp(0.95, 0.18, shiftP);
  const scaleIn = kit.P(t, 0.25, 0.8, kit.E.out);
  if (scaleIn > 0) {
    kit.drawScale(ctx, {
      palette: pal,
      cx: safe.cx,
      cy: 960,
      arm: 280,
      dropLen: 250,
      cost,
      alpha: scaleIn,
      leftLabel: '单次试错成本',
      rightLabel: '真实容错率',
    });
  }

  // Formula pill glowing at bottom
  const formP = kit.P(t, 2.7, 3.4, kit.E.back);
  if (formP > 0) {
    ctx.save();
    ctx.globalAlpha *= Math.min(1, formP * 2);
    ctx.translate(0, (1 - formP) * 50);
    kit.fillRR(ctx, safe.cx - 330, 1495, 660, 88, 44, 'rgba(79,240,176,0.12)', pal.GOOD, 3);
    kit.drawText(ctx, copy.formula || '容错率 = 1 / 单次试错成本', safe.cx, 1552, 38, {
      w: 800,
      col: pal.GOOD,
      al: 'center',
    });
    ctx.restore();
  }

  kit.drawWipeBand(ctx, t, duration, { width: w, height: h, palette: pal });
}
