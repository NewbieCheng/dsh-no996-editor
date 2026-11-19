---
name: openfilm-director
description: 用户要给一支片"定方案"——说了一句需求、丢来一段口播视频、或者问"这该怎么剪"时加载：结合工作模式(`auto`/`chat`/`design`/`produce`)完成素材盘点、导演视觉与动效设计卡、分镜定稿后再驱动制作。只问简单问题不要加载。
---

# 剪辑导演（OpenFilm）

这份技能管的是**先想清楚并对齐审美方案**，`openfilm-motion` 与 `openfilm-vibe-craft` 管的是**把高质感画面做出来**。顺序不能反：先有设计判断与分镜，再有动效量产。

## 一条铁律

**先有 `.film/storyboard.json`，再动时间轴。** 没有分镜就改片段，等于边拍边改剧本：每一轮都不一样，人也没法过目。

## 结合工作模式的导演流

- **`design` 模式 / 复杂新片（`auto` 自动先入 `design`）**：
  1. **全盘盘点素材**（不先干问）：调 `openfilm_assets` + 识图/`openfilm_frame`；口播先 `openfilm_transcribe`；人像叠加用 `openfilm_face_analysis` / `openfilm_cutout`；有音乐调 `openfilm_rhythm` 拿高潮与 BPM。
  2. **输出「导演视觉与动效设计卡」**：给出整体视觉气质、配色字重、分镜列表（含每镜隐喻 `explain` 与音画配合 `sfx`）、是“纯 Vibe 物理剧场”还是“实拍叠加 `VibeOverlay`”。
  3. **保存分镜并等确认**：写好 `.film/storyboard.json` 后停下请用户确认或微调；用户确认后调 `openfilm_mode(mode="produce")` 进入制作。
- **`produce` 模式 / 明确要求直接出片**：走 `openfilm_storyboard` → `openfilm-motion` G2 定调帧 → G3–G6 一气呵成。
- **`chat` 模式 / 小改**：只改局部文案/参数，不强推全套流程。

## 三条素材起点

### A. 有口播视频（用户丢来一个 mp4）
1. `openfilm_transcribe` 拿句级时间码；2. `openfilm_face_analysis` 记录人脸安全框；3. `openfilm_storyboard(op="from-script")` 与 `op="subtitles"`；4. 实拍之上按停顿/重点加透明 `VibeOverlay` 浮点强调与克制拟音（不遮脸与字幕）。

### B. 只有一句话需求（无素材或仅概念）
1. `openfilm_film` 读现有结构；2. `openfilm_library(kind="template")` 首推质量标杆 `vibe-explainer`（按需 `openfilm_kit(action="inspire")` 找新隐喻，**禁止机械抄袭样片旧主题**）；3. 写分镜 `op="write"` 后转 `openfilm-motion` G2。

### C. 改已经剪好的片
1. `openfilm_storyboard op="read"`；2. 局部修改后 `op="plan"` 检查影响；3. 小改直达源码与验证帧。

## 什么算"可以交给人看"

- 分镜文件存在，`op="plan"` 的 `missing` 为空；
- 至少抽查过定调帧 + 转场/高潮关键帧（`openfilm_frame`）；
- 字幕不折行、不压脸、不溢框；同轨音频不重叠；
- 导出回读过路径、分辨率、帧率、时长。
