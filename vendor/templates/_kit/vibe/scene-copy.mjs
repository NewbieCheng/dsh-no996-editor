// The eight scene roles follow the sample's original spoken arc. Source text
// stays data, independent of the diagram and layout selection.
export function vibeSceneCopy(shot) {
  const c = shot.copy ?? {};
  const table = {
    'shot-01': { motif: 'line', kicker: c.tag, heading: c.slam, deck: '把失败拆成付得起的小实验。', label: '风险预算 / 01', captions: [c.lead1, c.lead2] },
    'shot-02': { motif: 'balance', kicker: '原理 / 01', heading: '降低试错成本', deck: c.headline, label: c.formula, captions: ['试错越便宜，就越敢尝试', '把一次决策变成多次反馈'] },
    'shot-03': { motif: 'doors', kicker: '判断 / 02', heading: '先看能不能退', deck: c.headline, label: c.leftTitle, secondaryLabel: c.rightTitle, captions: ['能回头的事，先跨半步', '不能回头的事，先拆小'] },
    'shot-04': { motif: 'slices', kicker: '行动 / 03', heading: '拆成两周', deck: c.headline, label: c.focus, secondaryLabel: c.whole, captions: ['先验证最关键的一小块', '别一次押完所有时间'] },
    'shot-05': { motif: 'runway', kicker: '资源 / 04', heading: '拉长跑道', deck: c.headline, label: '保留主业底线 / 延长尝试窗口', captions: ['先留出能维持生活的空间', '再多跑几轮小实验'] },
    'shot-06': { motif: 'matrix', kicker: '沙盘 / 05', heading: '先试 96 次', deck: c.headline, label: '低成本模拟 / 12 × 8 格', captions: ['先把错误留在草稿里', '再把验证结果带进现实'] },
    'shot-07': { kicker: '清单 / 06', heading: '现在就做', deck: c.headline, items: Array.isArray(c.items) ? c.items.slice(0, 3) : [], captions: ['可逆、够小、先预演', '先做一个最小实验'] },
    'shot-08': { motif: 'closing', kicker: '结论 / 07', heading: '容错率是造的', deck: c.note, label: '最小实验 / 下一步', captions: [c.line1, c.line2] },
  };
  if (!Object.hasOwn(table, shot.id)) throw new Error(`Vibe scene content missing for ${shot.id}`);
  return table[shot.id];
}
