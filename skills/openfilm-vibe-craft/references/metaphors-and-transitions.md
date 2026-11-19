# 原创物理隐喻、生长转场与复杂组件速查

安装命令：`no996_kit(action="install", kits=["motion", "vibe-canvas"])`（或加 `vibe-overlay`）。

## 一、2.5D 虚拟运镜与视差（运镜即质感）

- `Motion.cameraKeyframe(t, [{ t, x, y, zoom, rotate }], { breath: 0.007 })`：自动按 `inOutCubic` 插值景别并叠加微呼吸，杜绝死帧。
- `VibeKit.withParallax(ctx, w, h, cam, 0.32, fn)`：远景层（极光/透视网格）。
- `VibeKit.withCamera(ctx, w, h, cam, fn)`：主体层（`1.0×`）。
- `VibeKit.withParallax(ctx, w, h, cam, 1.35, fn)`：前景景深光斑/角标层。

## 二、6 大“从上一幕自然生长”转场原语（`VibeKit.grow`）

| 生长转场 | API | 视觉用法 |
|---|---|---|
| 几何形变扩张 | `VibeKit.grow.morphExpand(ctx, fromRect, toRect, p, opts)` | 上一镜红卡/色块直接变形变色长成下一镜天平砝码、门框或跑道 |
| 穿越式钻入 | `VibeKit.grow.portalZoom(ctx, cx, cy, startR, endR, p, drawInner)` | 镜头钻进上一镜圆孔、门框或关键词笔画展开新世界 |
| 线条接力拐角 | `VibeKit.grow.lineCarry(ctx, points, p, opts)` | 上一镜下划线/进度条冲出后拐角围出下一镜画框或天平横梁 |
| 因果冲击揭示 | `VibeKit.grow.causalRipple(ctx, ox, oy, maxR, p, drawNext)` | 点击或收敛节点向四周炸开径向波纹揭示下一幕 |
| 同空间滑轨 | `VibeKit.grow.spatialSlide(ctx, w, h, p, dir, drawPrev, drawNext)` | 同一空间画布上下/左右平滑甩镜接棒（无黑屏无光带） |
| 2.5D 卡片翻面 | `VibeKit.grow.cardFlip3D(ctx, cx, cy, w, h, p, drawFront, drawBack)` | 卡面翻过 90° 侧棱掠过品牌高光，背面直接是下一幕 |

## 三、动作因果与复杂场景组件

| 场景需求 | 组件 / API | 说明 |
|---|---|---|
| **质感材质层** | `drawAuroraMesh` / `drawPerspectiveGrid` / `drawGlassCard` / `drawParticleFlow` | 流动极光底、3D 透视地板、带扫光的玻璃卡、贝塞尔粒子流 |
| **动作因果触发** | `drawCursorClick` / `Motion.anticipate` | 光标滑动按压弹涟漪触发窗体弹出；蓄力回撤后爆发 |
| **对话/辩论剧场** | `drawDialogueTheater(ctx, t, turns, opts)` | 双角色左右交锋气泡，后句砸入时前句退暗倾斜 |
| **首尾帧图文舞台** | `drawImageAnchorStage(ctx, t, frames, opts)` | 起/中/终 2~3 张真实图片或生图锚点 + 遮罩刮擦/推镜特写 |
| **实测声纹频谱** | `drawAudioSpectrum(ctx, t, rhythm, opts)` | 绑定 `window.RHYTHM` 拍点与起音，静默自动回落不造假 |
| **逻辑汇聚/对比/仪表** | `drawFlowNodes` / `drawCompareSlider` / `drawRadialGauge` | 多源贝塞尔粒子汇聚、前后对比拉杆、满弧扫针仪表 |
| **6 大经典隐喻** | `drawScale` / `drawDoors` / `drawSplitBar` / `drawRunway` / `drawSimGrid` / `drawChecklistRow` | 天平权衡、单双向门、裂解止损、时间跑道、96 格沙盘、打卡清单 |

## 四、`VibeOverlay`（`assets/vibe-overlay.js`）口播/实拍叠层

- `safeAnchor(faceBoxes, canvasSize, preferred)`：根据 `no996_face_analysis` 返回的脸框自动避让人脸与底部字幕区。
- `heroCallout` / `pillStagger` / `metricCompare` / `stepRail` / `focusHighlight`：透明叠层，不遮盖底层 `<video>`。
