function drawShot({ t, ctx, safe, pal, copy, kit, beatPulse }) {
  // Quiet orbital aura expanding around hero thesis
  const orbitP = kit.P(t, 0.1, 1.4, kit.E.out);
  if (orbitP > 0) {
    ctx.save();
    ctx.globalAlpha *= orbitP * 0.45;
    kit.circ(ctx, safe.cx, 880, 280 + beatPulse * 14, null, 'rgba(255,194,75,0.28)', 3);
    kit.circ(ctx, safe.cx, 880, 390 + beatPulse * 20, null, 'rgba(79,240,176,0.2)', 2);
    const angle = t * 0.75;
    kit.circ(ctx, safe.cx + Math.cos(angle) * 280, 880 + Math.sin(angle) * 280, 12, pal.ACC);
    kit.circ(ctx, safe.cx + Math.cos(angle + Math.PI) * 390, 880 + Math.sin(angle + Math.PI) * 390, 10, pal.GOOD);
    ctx.restore();
  }

  kit.drawRiseText(ctx, copy.line1 || '容错率，从来不是等来的', safe.cx, 760, 56, t, 0.25, {
    al: 'center',
    w: 700,
    col: pal.DIM,
  });

  kit.drawSlamText(ctx, copy.line2 || '而是你亲手造出来的', safe.cx, 940, 84, t, 0.95, {
    al: 'center',
    w: 900,
    col: pal.ACC,
    sh: 'rgba(255,194,75,0.5)',
    shb: 34,
    fromScale: 1.32,
  });

  kit.drawUnderline(ctx, safe.cx - 320, safe.cx + 320, 990, t, 1.3, 0.5, pal.GOOD, 8);

  const noteP = kit.P(t, 1.85, 2.55, kit.E.out);
  if (noteP > 0) {
    kit.drawText(ctx, copy.note || '把每一次未知，都变成可负担的小实验', safe.cx, 1140, 36, {
      w: 600,
      col: pal.INK,
      al: 'center',
      a: noteP,
    });
  }
}
