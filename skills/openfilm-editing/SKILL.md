---
name: openfilm-editing
description: How to cut a No996 Studio (OpenFilm engine) film well — shot grammar, wordart/fonts/filters/effects library usage, pacing, subtitles, transitions, sound, and export presets. Load when the person asks for anything about how the film looks, reads or sounds, or asks for a different style; the authoritative command and file reference stays with the no996_guide tool.
---

# 剪辑手法（不加班剪辑）

这份技能只讲「怎么剪得好」与**全量素材库何时怎么调**，命令与文件格式以 `no996_guide` 为准。

> **要做一支片 / 要重做画面 / 要换风格**：先加载 `openfilm-motion`，按 `docs/MOTION.md` 的七道闸门走完再回到这里抠剪辑细节。只改字幕、花字、滤镜、贴纸、换素材或调音量时用本技能即可。

## 一条片子的骨架

1. **先看再动**：`no996_film`（结构）+ `no996_fonts`（可用字体）+ `no996_frame`（画面）→ 才知道有什么、缺什么。
2. **定节奏**：开场镜头 2.5–3.5s，动作镜头 1.2–2.0s，收尾 3–5s，让最后一句话落地。
3. **一条主线**：观众一次只跟一条线；要并列就明说（分屏、字幕提示「同时」）。
4. **每次只改一件事**：改完立刻用 `no996_frame` 取样确认，别攒十个改动再一起看。

## 全量素材库与花字/字体/滤镜调用原则

- **字体（纯本地）**：给标题/花字/Canvas 设字体前先调 `no996_fonts`，优先从项目 `@font-face`、随包内置 `Smiley Sans`（得意黑）/ `ZCOOL KuaiLe`（站酷快乐体）或本机实装字体中选择，绝不盲猜字体名。
- **花字与文字（41 款花字 + 31 字效 + 90 文字模板，纯本地免联网）**：
  - 搜花字：`no996_library(kind="wordart", query="鎏金/霓虹/综艺/漫画/极光")` → 调 `inspect="<id>"` 拿真实 `--fill`/`--stroke`/`--glow` CSS 变量，既可用作设计参考写进自定义舞台，也可直接 `no996_clip(operations=[{ op: "insert", src: "openfilm/text/text", wordart: "...", textmotion: "...", font: "...", text: "...", at, duration, newTrack: 0 }])` 精准上轨！
- **滤镜调色（67 款 17 点 RGB 曲线，纯本地免联网）**：
  - 搜滤镜：`no996_library(kind="filter", query="胶片/港风/青橙/清新")` → 用 `no996_clip(op="insert", filter="openfilm/filters/...", amount=0.85, at=0, duration=..., newTrack=0)` 加全局调色层，或 `op="preset"` 单独调某一实拍片段。
- **特效/贴纸/图形/转场/关键帧**：
  - `effect`（70 款光效纹理）& `sticker`（56 款动态贴纸）& `layer`（5 款形状）纯本地可用；云端 `music`（6658 首）与 `stickers/emoji`（1587 款）首次取用从 `openfilm.dev/library` 缓存至 `~/.openfilm/library`，若断网可改用本机 20 音效 / 内置 Vibe BGM / 动态 SVG 贴纸。

## 镜头与转场

| 场景 | 建议 |
|---|---|
| 动效/概念片切镜 | **优先从上一幕生长出来**（`morph-expand` / `portal-zoom` / `line-grow` / `card-flip` / `spatial-pan`）；拒绝 PPT 式清屏与连续擦除 |
| 同场景实拍切镜 | 干净硬切，配合景别推拉切换（全景→特写），或配 `no996_library(kind="motion")` 关键帧 |
| 换时间 / 舒缓叙事 | 0.3–0.5s 交叉溶解或页面转场（`no996_library(take=..., cut=...)`） |
| 强调（数字、结论） | 快速推镜特写 + 因果冲击（光标点击 / 撞击波纹）+ 花字重点高亮 |
| 收尾 | 慢拉远全景 + 音频 1.2s 自然淡出 |

- **动效设计四大核心原则**：镜头连贯生长、动作因果触发、快慢与景别变化、运镜即质感。
- 不要连续三个以上同类特效转场（观感像 PPT）。

## 字幕

- 每行 ≤ 18 个汉字（英文 ≤ 42 字符），一行显示完，不要折行。
- 断句按语义，不按字数；句尾对齐画面切换点前后 0.2s 内最佳。
- 关键数字/品牌名单独一行并加粗，其余保持同一样式。
- 与画面保持 ≥ 32px 安全边距（1080p 下），不要压到主体。

## 声音

- 配音/对话优先于音乐：先用 `no996_audio(action="extract")` 或 `no996_transcribe` 拿说话区间，再调 `no996_audio(action="duck")` 自动压低人声期配乐 -12 dB；Vibe 科普片可用 `no996_audio(action="bgm-install", id="vibe-we-never")` 装入内置配乐与实测拍点。
- 音效只在动作/重音点用（可通过 `no996_sfx` 合成 12 类确定性音效并自动分轨），一个动作一个音效，**同轨 `<audio>` 严禁重叠**；轻柔叙事或纯微调时保持克制。
- 全片响度对齐到 -14 LUFS（短视频）/ -16 LUFS（长片）；**默认交付到预览态，用户开启自动导出或明确要求时再调 `no996_export` 导出成片**。
- 人像口播加解释浮层时，先用 `no996_face_analysis` 取脸框，再用 `VibeOverlay.safeAnchor` 贴合空白区，严禁压脸或压字幕。

## 导出档位

| 用途 | 设定 |
|---|---|
| 预览 / 快速迭代 | 720p，CRF 28，逐帧检查用 |
| 短视频（竖屏） | 1080×1920，H.264 CRF 20，-14 LUFS |
| 横屏成片 | 1920×1080，H.264 CRF 18，-16 LUFS |
| 需要透明度 | WebM/VP9 或 ProRes 4444（先 `no996_export` 查本机编码支持） |

## 风格清单（person 说「换个风格」时先问这一句）

一句话就能定风格：**给谁看、多久、什么情绪**。三样齐了再动手，否则先问。
常用风格与手段：

- **干净讲解**：无转场、字幕大而少、白底或纯色背景、语速稳。
- **快节奏口播**：1.2s 切镜、字幕跟读、音效打点、数字放大。
- **故事感**：慢推镜头、环境音铺底、字幕只在关键句出现。
- **产品演示**：分屏对比、局部放大、光标跟随标注。

## 红线

- 不改 `film.html` 的结构性内容（track 顺序、clip id）除非 person 明确要求。
- 不加未在素材库出现的素材或未查 `no996_fonts` 的未知字体；缺素材时用 `no996_library` 或 `no996_assets` 补。
- 不猜时长/帧率/编码：从 `no996_film` 读到的值就是唯一真值。
