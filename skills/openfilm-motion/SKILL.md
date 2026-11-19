---
name: openfilm-motion
description: 做一支片、重做画面、要更炫的动效、要换整片风格，或人说"开始/继续"一支影片时加载：七道闸门的生产协议（分镜→定调帧→量产→声音→帧检→交付）、动作词汇表、14 种风格与 124 张镜头卡索引、以及"什么时候算做完"的契约。只问问题或只改字幕文字时不要加载。
---

# 动效生产（OpenFilm）

权威规范在 `docs/MOTION.md`。做强质感科普或无口播动效大片时，同步加载 `openfilm-vibe-craft`；**不要停下来问"要不要继续"**（仅在 `design` 模式下按规范等待用户确认设计卡与分镜）。

## 先判断：这是不是一支片

- 要做/要改/要换风格的**画面** → 走下面的协议（先读 `.film/storyboard.json` 和当前工作模式）。
- 只问问题、只改字幕文字、只换素材音量 → 用 `openfilm-editing`，不要开生产线。

## 七道闸门

| 闸门 | 做什么 | 通过条件 |
|---|---|---|
| G0 接单 | `openfilm_film` + `openfilm_assets` 盘点；定受众/时长/情绪 | 三个默认值定了 |
| G1 分镜 | `openfilm_storyboard` 落盘：秒/画面/动作/`explain`/`sfx` | 总时长对齐；一镜一件事 |
| G2 定调帧 | **只写第 1 镜**，`openfilm_frame` 抽 60% 时刻亲眼看 | 说得出底色/最大字/视觉重心 |
| G3 量产 | 其余镜头；用 `openfilm_kit` 装 `motion`/`vibe-canvas`/`vibe-overlay` | 每镜有进出场；无静止 >1.2s |
| G4 声音 | 有 BGM 用 `openfilm_rhythm` 取拍点；按需 `openfilm_sfx` 配声；口播先转写 | 字幕不折行；同轨零重叠；人脸不遮挡 |
| G5 帧检 | `openfilm_frame` 抽切点前后各 1 帧 + 中点 + **100 分自检** | 评分 ≥80 且无黑场/闪烁/溢出 |
| G6 交付 | `openfilm_export` → 回读规格 | 回读到路径+分辨率+帧率+时长 |

**G2 不过，不许写 G3。** 风格不对只回 G2，不要从头再来。

## 动作词汇与通用工具（可复用至任意项目）

- **基础库（`assets/motion.js`）**：`seg / stagger / cubicOut / quintOut / backOut / spring / drop / wallScale / shake / slam / steps / pulse / wipeBand / carryPose / det / halton / pose / enter / exit / camera / grain`
- **高频工具**：`openfilm_kit`（检索 14 风格 + 124 镜头卡 & 一键装入 `motion`/`vibe-canvas`/`vibe-overlay`）、`openfilm_rhythm`（实测拍点与高潮分析）、`openfilm_sfx`（12 类确定性拟音 + 自动分轨/stem 混音）、`openfilm_face_analysis` / `openfilm_cutout`（防挡脸定位与抠图）、`openfilm_mode`（上报工作阶段切换）。

原则：**闭式解**（只依赖 `t`）、**确定性**（禁 `Math.random`/`Date.now`）、**创意隐喻优先、拒绝死套模板**。

## 红线

静止 >1.2s、全片线性缓动、四向同时飞入、文字越界、连续 3 镜同类特效转场、同轨音频重叠、
配色超 4 色、数字直跳、遮挡人脸字幕、未抽帧假称完成——出现任意一条立刻返工。
