---
name: openfilm-director
description: 用户要给一支片"定方案"——说了一句需求、丢来一段口播视频、或者问"这该怎么剪"时加载：从 brief 到分镜到时间轴的导演流程（先转写、再分镜、后动时间轴），以及什么算"可以交给人看"。要动手做画面时再叠加 openfilm-motion；只问问题不要加载。
---

# 剪辑导演（OpenFilm）

这份技能管的是**先想清楚**，`openfilm-motion` 管的是**把画面做出来**。顺序不能反：先有分镜，再有动效。

## 一条铁律

**先有 `.film/storyboard.json`，再动时间轴。** 没有分镜就改片段，等于边拍边改剧本：每一轮都不一样，人也没法过目。

## 三段流程

### A. 有口播视频（用户丢来一个 mp4）

| 步 | 做什么 | 工具 | 通过条件 |
|---|---|---|---|
| A1 | 转写，拿带时间码的句子 | `openfilm_transcribe`（`from` 绝对路径） | 返回 `transcriptPath` 和段落时间码 |
| A2 | 生成分镜：一句一镜、切在句尾 | `openfilm_storyboard op=from-script transcriptPath=…` | 总时长 ≈ 视频时长；没有跨句切点 |
| A3 | 出字幕 | `openfilm_storyboard op=subtitles transcriptPath=…` | 一行不折、一条不超过 2 行 |
| A4 | 把分镜落到时间轴 | `openfilm_storyboard op=plan` → 把返回的 operations 交给 `openfilm_clip` | `plan` 里 `missing` 为空，或说明缺哪个素材 |
| A5 | 画面：动效、调色、节奏 | 转 `openfilm-motion`（G2 定调帧开始） | 看过定调帧 |

**A1 没做完不要问"你想怎么剪"。** 口播的时序就是分镜的骨架，先拿出来再说。

### B. 只有一句话需求

1. `openfilm_film` 看现有结构；空片就按这句话自定受众/时长/气质（三个默认值自己定，不要连着问）。
2. `openfilm_library kind=template` 看有没有现成模板；有就 `take=<id>` 读它的使用说明。
3. 写分镜（`op=write`），每镜一件事、一句屏上字。
4. 进 `openfilm-motion` 的 G2。

### C. 改已经剪好的片

1. `openfilm_storyboard op=read`：先看计划是什么。
2. 改哪一镜就改哪一镜，再 `op=plan` 看时间轴要动哪几步。
3. 只改字幕/音量：不用动分镜，直接用 `openfilm_clip` / Studio。

## 分镜怎么写（`op=write`）

| 字段 | 要求 |
|---|---|
| `from` / `to` | 成片秒数，单调、不重叠；单镜 2–8 秒，超过 12 秒拆开 |
| `kind` | `talking-head` / `broll` / `title` / `cutaway` / `screen` / `end-card` |
| `motion` | 只能用动作词汇表里的名字（见 `openfilm-motion`），不要自创 |
| `caption` | 屏上字 ≤ 40 字；一句话讲不完就拆镜 |
| `source` + `in`/`out` | 素材在项目内；`in`/`out` 是素材里的秒数 |

工具会拒绝重叠、倒序、未知 `motion`、重复 id——**被拒绝就改分镜，不要绕过去手写 film.html**。

## 什么算"可以交给人看"

- 分镜文件存在，`op=plan` 的 `missing` 为空；
- 至少一帧是真的画出来看过的（`openfilm_frame`）；
- 字幕不折行、不压脸；
- 导出回读过路径、分辨率、帧率、时长。

少一条就说少哪条，不要用"应该没问题"代替。
