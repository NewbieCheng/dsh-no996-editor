---
name: openfilm-vibe-craft
description: 制作知识科普/概念解释视频、无口播纯画片、强质感大字动效、或用户要求“像 Vibe 那样炫酷/有物理节奏与音效”时加载：原创视觉隐喻方法论、音乐拍点高潮映射、克制拟音编排与 100 分转场动效评分标准。先读本技能，再按 `openfilm-motion` 七道闸门推进；禁止生搬硬套样片内容。
---

# Vibe 创作心法（OpenFilm）

`vibe-explainer` 是**质量标杆**，不是死板样板间。每做一支新片，必须按主题重新设计视觉隐喻，禁止只换字不换结构。

## 1. 先盘素材，定三条赛道
1. **纯概念/无素材**：用 `openfilm_kit(action="install", kit="vibe-canvas")` 搭动态剧场（全 Canvas 2D 物理动效 + 隐喻大字 + `openfilm_sfx` 拟音），无需强等真实拍摄。
2. **有口播/实拍**：口播时序优先（`openfilm_transcribe`），并用 `openfilm_face_analysis` 定位脸框，再用 `VibeOverlay.safeAnchor` 在空侧贴透明浮动解释贴片，严禁盖住人脸和字幕。
3. **图文混剪/产品演示**：`openfilm_cutout` / 识图抽真实焦点后，以 `Motion` 弹簧 + `VibeKit` 卡片/清单/分栏对比串联。

## 2. 六步创意编导法（禁止套壳）
1. **抽核心冲突**：把文字观点变成可见的**物理对抗/状态转变**（权重失衡→逆转、门阻→穿越、整块→裂解止损、跑道烧尽→扩容、百次试错→单点命中、清单→打勾波纹，或自创雷达/漏斗/齿轮）。
2. **节奏密度**：每 1.0–1.5s 必须有一次状态推进或重音；静帧禁止超过 1.2s。
3. **动作四段式**：准备(微退) → 主运动(弹簧过冲 `spring`/`E.back`) → 余震(`shake`)/高光(`glow`) → 连续承接(`carryPose`)。
4. **音画分流（不乱加、加必准）**：
   - 有 BGM 时调 `openfilm_rhythm` 取实测重拍与高潮段，再安排强镜头。
   - **克制拟音**：纯问答/安静纪录片不乱配；节奏/科普片调 `openfilm_sfx` 在大字砸入(`hit`)、扫屏转场(`whoosh` 提前 `0.18s`)、打勾(`bell`) 配齐，**同轨 `<audio>` 严禁重叠**。
5. **乱序抽帧铁律**：只允许闭式函数 `f(t)`，严禁 `Math.random`/`Date.now`/`requestAnimationFrame` 状态累计。
6. **交付前 100 分自检**：`references/rubric-and-audio.md` 达 `≥80 分` 且零红线再交付。

需要隐喻代码原语速查时读 `references/metaphors-and-transitions.md`；需要完整评分细则时读 `references/rubric-and-audio.md`。
