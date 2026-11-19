function drawShot({ t, duration, ctx, w, h, safe, pal, copy, kit }) {
  kit.drawRiseText(ctx, copy.headline || '今天就做这 3 件事', safe.cx, 380, 68, t, 0.15, {
    al: 'center',
    w: 900,
    col: pal.ACC,
  });

  const items = Array.isArray(copy.items) ? copy.items : [
    { title: '先找一扇双向门', sub: '可撤销、能重来的事，别原地内耗' },
    { title: '把计划切成两周块', sub: '写死止损线，只验证最小关键问题' },
    { title: '先用草稿/沙盘跑一遍', sub: '零成本暴露坑位，再投入真时间' },
  ];

  items.forEach((item, idx) => {
    const enterStart = 0.4 + idx * 0.28;
    const doneStart = 1.2 + idx * 0.85;
    kit.drawChecklistRow(ctx, {
      palette: pal,
      x: safe.left,
      y: 510 + idx * 280,
      width: safe.span,
      height: 220,
      num: idx + 1,
      title: item.title,
      sub: item.sub,
      enter: kit.P(t, enterStart, enterStart + 0.55),
      done: kit.P(t, doneStart, doneStart + 0.45),
      ripple: kit.P(t, doneStart + 0.05, doneStart + 0.85, kit.E.out),
    });
  });

  kit.drawWipeBand(ctx, t, duration, { width: w, height: h, palette: pal });
}
