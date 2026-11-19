# Vibe 科普剧场 · 连续生长编导指南

把 `vibe-explainer` 当作**动效质感与单镜头连贯性的标杆**，不要当填空模板！

## 1. 动效设计四大核心原则（唯一准绳）
- **镜头连贯性（从上一幕自然生长）**：严禁 PPT 式清屏与连续 `drawWipeBand` 擦除！用 `VibeKit.grow`（`morphExpand` / `portalZoom` / `lineCarry` / `causalRipple` / `spatialSlide` / `cardFlip3D`）或 `continuousStage` 让上一镜元素直接生长成下一镜主舞台。
- **动作因果性**：禁止元素无因蹦出！用 `VibeKit.drawCursorClick`（光标点击→窗体弹出）、球体碰撞、激光切割、粒子汇聚来触发每一次画面变化。
- **节奏与景别变化**：每镜至少 1 次景别切换（推镜特写 / 跟拍 / 拉远结论），禁止全程固定全景。
- **运镜即质感**：用 `Motion.cameraKeyframe` + `VibeKit.withCamera` / `withParallax` 配合 `drawAuroraMesh` / `drawGlassCard` / `drawAudioSpectrum` 建立纵深材质。

## 2. 内置配乐与多模态协同
1. **默认音乐**：调用 `openfilm_audio(action="bgm-install", id="vibe-we-never", duration=<片长>)` 自动装入《We Never · 若如初见》与实测拍点 `assets/rhythm-data.js`。
2. **有口播/对话视频**：先 `openfilm_transcribe` + `openfilm_audio(action="extract" / "duck")` 防止配乐压人声，对话交锋用 `drawDialogueTheater`；实拍叠层用 `VibeOverlay` 避开人脸。
3. **首尾帧图文协同**：对复杂视觉变化，用用户上传图或 `openfilm_generate_image`（起/中/终关键帧）搭配 `drawImageAnchorStage` 渲染。
