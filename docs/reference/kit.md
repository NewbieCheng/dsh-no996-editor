<!-- doc
id: reference-kit
reader: 做模板、挑风格、查镜头卡的人
fact-source: vendor/templates/_kit/catalog.json、vendor/motion/*/catalog.json、vendor/templates/*/template.json（scripts/gen-docs.mjs 生成）
checked: generated
rot-if: 单元/模板/风格/镜头卡增删（重新生成即可）
-->

# 素材库与动效索引（自动生成）

> 生成命令：`npm run docs:gen`。**数量只允许出现在这一页**，正文写"8 个单元""124 张卡"，
> 第二天就会错——需要数字就链接到这里，或者让脚本生成本页。

## 1. 模板（4 个）

| 模板 | 单元族 | 画布 | 镜头数 | 标题 |
|---|---|---|---|---|
| `motion-styles` | motionstyle | 1080×1920 | 2 | 动效风格样片 |
| `paper-texture` | paper | 1080×1920 | 2 | 纸纹讲堂 |
| `sketchnote` | sketch | 1080×1920 | 7 | 点阵手账 · 费曼学习法 |
| `vibe-explainer` | vibe | 1080×1920 | 8 | Vibe 科普剧场 · 容错率是造出来的 |

## 2. 单元（8 个，paper 8）

### paper.*（8）

| 单元 | 种类 | 说明 |
|---|---|---|
| `paper.grain` | layer | 纸张颗粒噪点层，铺满画面；只在需要纹理的镜头上出现 |
| `paper.head` | block | 顶部双行标题 |
| `paper.stage` | block | 中上部通栏课件区：白色纸卡 + 虚线占位框，用来放 PPT / 截图 / 板书 |
| `paper.nameplate` | block | 左下竖排名牌（writing-mode: vertical-rl），放讲者姓名或栏目名 |
| `paper.presenter` | block | 右下圆角人物窗口占位 |
| `paper.capsule` | block | 底部炭黑字幕胶囊 |
| `paper.steps` | block | 竖排步骤容器：编号圆点 + 标题 + 说明 |
| `paper.step` | item | 单个步骤条目（仅由 paper.steps 重复使用） |

## 3. 动效

| 项 | 数量 | 出处 |
|---|---|---|
| 整片风格 | 14 | `vendor/motion/styles/catalog.json` |
| 镜头卡 | 124 | `vendor/motion/shotcards/catalog.json` |
| 镜头卡分类 | 10 | 同上 |

选风格与镜头卡的说明在 [`../MOTION.md`](../MOTION.md) 第 6 节（那一节也是生成的）。

