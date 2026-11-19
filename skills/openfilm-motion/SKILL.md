---
name: openfilm-motion
description: 做一支片、重做画面、要更炫的动效、要换整片风格，或人说"开始/继续"一支影片时加载：七道闸门的生产协议（分镜→定调帧→量产→声音→帧检→预览交付）、动效设计四大核心原则、14 种风格与 124 张镜头卡索引。只问问题或只改字幕文字时不要加载。
---

# 动效生产（OpenFilm）

权威规范在 `docs/MOTION.md`。做强质感科普、对话剧场或图文动效大片时，同步加载 `openfilm-vibe-craft`；**不要停下来问"要不要继续"**（仅在 `design` 模式下按规范等待用户确认设计卡与分镜）。

## 唯一动效准绳（四大核心原则）

1. **镜头连贯性**：拒绝 PPT 式割裂画面，下一幕必须从上一幕的容器、线条、洞口、卡面或空间滑轨中**自然生长**出来（`VibeKit.grow` / 连续舞台）。
2. **动作因果性**：每个动效必须有明确触发逻辑（如光标点击、碰撞、激光切分、粒子汇聚），禁止元素无因蹦出。
3. **节奏与景别变化**：快慢交替，重点信息配合推镜特写与拉远收束，杜绝全程固定全景。
4. **运镜即质感**：每镜使用 `Motion.cameraKeyframe` + `VibeKit.withCamera`/`withParallax` 精准控制推拉摇移与景深层次。

## 七道闸门

| 闸门 | 做什么 | 通过条件 |
|---|---|---|
| G0 接单 | `no996_film` + `no996_assets`（含网页 `inspectUrl`）+ `no996_fonts` + `no996_library`（查花字/滤镜/模板参考） | 三个默认值、可用字体与视觉风格定了 |
| G1 分镜 | `no996_storyboard` 落盘：秒/画面/`camera`/`trigger`/`growth`/`explain`/`sfx` | 总时长对齐；零连续擦除/零固定全景告警 |
| G2 定调帧 | **只写第 1 镜**，`no996_frame` 抽 60% 时刻亲眼看 | 说得出底色/材质层次/字体花字/景别重心/因果触发 |
| G3 量产 | 其余镜头；用 `no996_kit` 装运行时，必要时 `no996_clip(insert/preset)` 挂花字/滤镜/贴纸 | 每镜有生长承接与景别起伏；无静止 >1.2s |
| G4 声音 | Vibe 用 `no996_audio` 装内置 BGM；有口播/对话做 `extract` + `duck` 闪避；按需 `no996_sfx` | 字幕不折行；同轨零重叠；配乐不压人声 |
| G5 帧检 | `no996_frame` 抽**切点前 0.1s / 切点 0s / 切点后 0.1s 三联帧** + 每镜中点 + **100 分自检** | 评分 ≥80 且切点无缝生长、零红线 |
| G6 交付 | **默认交付预览态**；仅当 `autoExport` 开启或用户明确要求时才调 `no996_export` 并回读规格 | 预览已验 / 开启导出时回读到真实输出 |

**G2 不过，不许写 G3。** 风格不对只回 G2，不要从头再来。

## 动作词汇与通用工具（可复用至任意项目）

- **基础库（`assets/motion.js`）**：`seg / stagger / cubicOut / quintOut / backOut / spring / drop / wallScale / anticipate / overshootLerp / bezierPoint / pathProgress / cameraKeyframe / morphBox / colorLerp / shake / slam / steps / pulse / wipeBand / carryPose / det / halton / pose / enter / exit / camera / grain`
- **高频工具**：`no996_fonts`（扫系统/项目/内置字体）、`no996_library`（全品类检索 + `inspect` 读取花字/滤镜/关键帧/多轨模板配方）、`no996_clip`（直接上轨花字/滤镜/贴纸/片段与原子调轨）、`no996_kit`（14 风格 + 124 镜头卡 & 一键装入运行时）、`no996_audio`（视频抽音 / 内置《We Never》+拍点 / 人声闪避）、`no996_rhythm`（自选音乐测拍）、`no996_sfx`（12 类确定性拟音）、`no996_assets`（本地导入 + 网页抓图）、`no996_face_analysis` / `no996_cutout`、`no996_mode`。

原则：**闭式解**（只依赖 `t`）、**确定性**（禁 `Math.random`/`Date.now`）、**连续生长与因果驱动优先**。

## 红线

连续 ≥3 镜清屏擦除、全程固定单一机位、元素无因弹出、静止 >1.2s、文字越界、同轨音频重叠、配乐压人声、未抽帧假称完成、未授权自动导出——出现任意一条立刻返工。
