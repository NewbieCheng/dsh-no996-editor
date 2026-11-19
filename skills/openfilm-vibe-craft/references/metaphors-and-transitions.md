# 原创物理隐喻与转场原语速查

## 一、`VibeKit`（`assets/vibe-canvas.js`）核心原语

安装命令：`openfilm_kit(action="install", kit="vibe-canvas")`（会自动附带 `motion.js`）。

| 隐喻场景 | 组件名 | 关键参数与用法 | 适用观点 |
|---|---|---|---|
| 反比 / 权衡 | `drawScale` | `cost (0.12..1)`, `leftLabel`, `rightLabel`, `arm`, `dropLen` | 试错成本 vs 容错率、投入 vs 回报 |
| 不可逆 / 可撤销 | `drawDoors` | `leftClosed`, `rightClosed`, `actorLeftX`, `actorRightX` | 单双向门、沉没成本、行动阻力 |
| 拆大为小 / 止损 | `drawSplitBar` | `split`, `fall`, `pick`, `count`, `wholeText`, `focusText` | MVP 拆解、阶段止损、复杂度切分 |
| 时间余量 / 扩容 | `drawRunway` | `total`, `baseFilled`, `burnRates[]`, `added[]` | 现金流跑道、缓冲时间、护城河 |
| 沙盘收敛 / 排雷 | `drawSimGrid` | `cols`, `rows`, `times[]`, `order[]`, `collapse`, `t` | AI 试错、A/B 测试、千次预演 |
| 执行清单 / 打卡 | `drawChecklistRow` | `num`, `title`, `sub`, `enter`, `done`, `ripple` | 行动指南、关键结论勾选 |

> 原创原则：主题不适合上述 6 种时，利用 `drawRiseText`、`drawSlamText`、`drawBigNum`、`fillRR`、`line`、`circ` 和 `Motion`（`spring`/`slam`/`shake`/`wipeBand`/`carryPose`）直接绘制新隐喻！

## 二、`VibeOverlay`（`assets/vibe-overlay.js`）口播/实拍叠层

- `safeAnchor(faceBoxes, canvasSize, preferred)`: 根据 `openfilm_face_analysis` 返回的脸框自动避让人脸与底部字幕区。
- `heroCallout` / `pillStagger` / `metricCompare` / `stepRail` / `focusHighlight`: 全程只绘制透明浮层组件（不覆盖背景 `<video>`），配合 `VibeOverlay.createOverlayRoot(w, h)` 挂载在镜头页上。

## 三、常见转场规范

1. **同景切镜**：干净硬切或仅在相邻元素做 `carryPose` 位移接力。
2. **章间推进**：`drawWipeBand(ctx, t, duration, ...)` 提前 `0.16s` 起扫 + 配套 `whoosh` 提前 `0.18s`。
3. **重击切点**：`motion.slam` 缩放 `1.5→1` 落点踩正 `0.00s` + `motion.shake` 微震 + `sfx: hit`。
4. **避免廉价 PPT 感**：连续 3 镜不要用同类擦除转场。
