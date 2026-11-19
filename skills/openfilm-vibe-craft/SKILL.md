---
name: openfilm-vibe-craft
description: 制作知识科普/概念解释视频、无口播纯画片、对话交锋剧场、图文首尾帧动效、或用户要求“像 Vibe 那样炫酷/连贯生长/有物理节奏与音效”时加载：动效设计四大核心原则、原创视觉隐喻、内置《We Never》实测拍点与 100 分自检。先读本技能，再按 `openfilm-motion` 七道闸门推进；禁止生搬硬套样片内容。
---

# Vibe 创作心法（OpenFilm）

`vibe-explainer` 是**单镜头连续生长与运镜质感的标杆**，不是死板样板间。每做一支新片，必须遵守下方四大唯一准则并按主题原创隐喻。

## 0. 动效设计四大核心原则（唯一强制准绳）

1. **镜头连贯性（拒绝 PPT 清屏）**：严禁每镜清屏重来与连续 `drawWipeBand` 擦除！用 `VibeKit.grow`（`morphExpand` / `portalZoom` / `lineCarry` / `causalRipple` / `spatialSlide` / `cardFlip3D`）或单场连续 `globalT` 舞台，让上一幕的元素、线条、洞口或卡面直接**自然生长**成下一幕主舞台。
2. **动作因果性（禁止无因蹦出）**：每次出现或切换必须有触发源——`drawCursorClick` 光标点击、物体碰撞、激光劈裂、进度扫满、粒子汇聚或强起音冲击。
3. **节奏与景别变化（禁止固定全景）**：快慢交替；高潮与核心金句配合推镜特写（`zoom 1.0→1.15+`），解释期适度停留阅读，结论期拉远收束。
4. **运镜即质感**：用 `Motion.cameraKeyframe` + `VibeKit.withCamera` / `withParallax`（背景 `0.3×` / 主体 `1.0×` / 前景光斑 `1.35×`）叠 `drawAuroraMesh` / `drawPerspectiveGrid` / `drawGlassCard` / `drawAudioSpectrum` 建立立体材质。

## 1. 先盘素材，定四条赛道

1. **纯概念/无素材**：`no996_fonts` 选实装字体 + `no996_library(kind="wordart", inspect=...)` 借鉴花字配色描边 + `no996_kit(action="install", kits=["motion", "vibe-canvas"])` 搭连续动态剧场 + `no996_audio(action="bgm-install", id="vibe-we-never", duration=<片长>)` 装入《We Never · 若如初见》及实测拍点。
2. **有口播/实拍**：`no996_transcribe` 拿句级时间码 + `no996_face_analysis` 避脸 + `VibeOverlay.safeAnchor` 透明叠层或 `no996_clip(insert/preset)` 叠花字/滤镜；若加 BGM 必须走 `no996_audio(action="duck")` 人声闪避。
3. **对话/辩论/访谈**：`no996_audio(action="extract")` 切分说话段落与停顿，用 `drawDialogueTheater` 做双角色气泡交锋与镜头推近特写。
4. **首尾帧图文协同 / 网页产品页**：用用户上传的起/中/终关键帧、`no996_assets(inspectUrl/fromUrl)` 抓回的网页实图，或 `no996_generate_image` 生成关键帧，由 `drawImageAnchorStage` 演活中间转场、放大特写与标注引线。

## 2. 六步创意编导法

1. **抽核心冲突**：把文字观点变成可见的**物理对抗/状态转变**（天平权衡、双向门碰撞、激光裂解、跑道扩容、96 格收敛、因果光流汇聚、仪表面板拉满等）。
2. **锁定生长链与景别曲线**：开场前先画好相邻切点的 `growth` 链条与 `cameraKeyframe` 曲线，确保 7 个切点用上 ≥3 种不同生长转场。
3. **动作四段式**：预备回撤(`Motion.anticipate`) → 主运动(`spring`/`E.back`) → 余震(`shake`)/高光(`glow`) → 连续承接(`morphBox`/`carryPose`)。
4. **音画精准咬合**：Vibe 知识大赏优先用内置《We Never · 若如初见》（BPM 112.3，16s/24s/104s Drop）；用 `no996_sfx` 在大字砸入(`hit`)、点击(`click`)、裂解(`crack`)、打勾(`bell`)、平滑过渡(`whoosh` 提前 `0.18s`) 精确落拍，**同轨 `<audio>` 严禁重叠**。
5. **乱序抽帧铁律**：只允许闭式函数 `f(t)`，严禁 `Math.random` / `Date.now` / `performance.now`。
6. **交付前 100 分自检 + 切点三联帧检**：读 `references/rubric-and-audio.md` 达 `≥80 分` 且零红线再交预览。

原语速查见 `references/metaphors-and-transitions.md`；完整评分细则见 `references/rubric-and-audio.md`。
