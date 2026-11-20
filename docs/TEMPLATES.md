<!-- doc
id: templates
reader: 做模板的人
fact-source: vendor/templates/**、scripts/templates-build.mjs
checked: 0.19.11
rot-if: 模板结构、_kit、构建流程或提示词注入链路变化
-->

# 模板与素材库

四个随插件发布的模板：首推 **`vibe-explainer`**（Vibe 科普剧场，含 Canvas 2D 物理隐喻与确定性拟音轨），以及 `paper-texture`（纸纹讲堂）、
`sketchnote`（手绘笔记）、`motion-styles`（动效风格样片）。前三个是**数据 + 素材单元/场景**
经 `scripts/templates-build.mjs` 生成的产物（支持 `sfxCues` 合成 `.wav` 与双轨无重叠 `<audio>`）；`motion-styles` 是**整片样片**的直接封装
（见文末「动效风格样片」）。原 `replica-film`（产品名「知识大赏」）已移除。

```
vendor/templates/
├── _kit/                     ← 素材库（源）
│   ├── catalog.json          ← 机器可读目录：每个单元的槽位、说明、样式文件
│   ├── render.mjs            ← 组装器：槽位填充、重复块、单元样式与音轨合并
│   ├── motion/motion.js      ← 闭式物理缓动与摇晃/砸入/扫光/接力原语
│   ├── vibe/{vibe-canvas.js,vibe-overlay.js,page.mjs} ← Vibe 原创隐喻画布 + 口播避脸浮层
│   ├── paper/{tokens.css,units/*,page.mjs}
│   └── sketch/page.mjs
├── paper-texture/
│   ├── manifest.json         ← 给 OpenFilm 的元信息（不变）
│   ├── template.json         ← 给构建器的元信息（kit / 尺寸 / 镜头墙标题）
│   ├── shots/shot-01.json    ← 一个镜头 = 一份数据
│   ├── pages/shot-01.html    ← 产物（提交进仓库）
│   └── assets/kit.css        ← 由 _kit 合并出的样式（产物）
```

## 为什么要有构建步骤

OpenFilm 把页面当**静态 HTML** 渲染：没有打包器、没有模块加载、没有 fetch。
所以"可编辑"只能落在两处：

1. **源**要小、要人能读懂：一个镜头一份 JSON，一个单元一对 `.html`/`.css`；
2. **产物**要能直接跑：生成好的页面提交进仓库，模板安装/播放时不依赖任何工具。

代价是改了源必须重新生成（`npm run templates:build`）。这一点有测试兜底：
`npm run templates:check` 在页面与源不一致时退出码为 1，CI/提交前跑一次即可。

## 各模板的模型不同，不要套用同一套思路

| 模板 | 模型 | 可编辑的东西 |
|---|---|---|
| `vibe-explainer` | **单镜头连续生长剧场（首推标杆）**：共享 `globalT` 世界舞台 + 2.5D 景别运镜 + 6 大生长转场 + 内置《We Never》实测拍点与拟音轨 | `shots/*.json`（文案/色板/时长）+ `stage.js` + `template.json`（`builtinRhythm` / `sfxCues`） |
| `paper-texture` | **静态页 + 避脸浮层**：主页面按需叠加 `VibeOverlay` 透明高亮卡片 | `shots/*.json` 的 `copy`（文案）与 `vars`（字号/位置） |
| `sketchnote` | **一场戏多窗口**：七个镜头是同一张纸面的七个时间窗 | `vendor/templates/sketchnote/assets/notebook-config.js`（内容）+ `shots/*.json`（窗口） |
| `motion-styles` | **整片样片直封**：一个镜头 = 一支上游 10 秒样片 | `shots/*.json` 的 `style`（样片 slug）与 `duration`；画面改 `vendor/motion/styles/demos/<slug>/index.html` |

`sketchnote` 的 `notebook.js` 按**绝对时间**绘制整场戏，页面只声明 `START` /
`DURATION`。窗口写错时画面看着正常、内容却错位，所以有一个测试专门校验七个
窗口首尾相接。

## 素材单元（catalog）

所有单元登记在 `vendor/templates/_kit/catalog.json`：

```json
"paper.head": {
  "file": "paper/units/head.html",
  "css": "paper/units/head.css",
  "kind": "block",
  "slots": ["kicker", "title"],
  "vars": ["--kicker-size", "--title-size", "…"],
  "doc": "顶部双行标题。kicker 是字距拉开的小字，title 可用 <em> 做麦黄衬底高亮。"
}
```

- `file` / `css` 是相对 `_kit/` 的路径；`kind` 为 `block`（独立区块）或 `item`（只被重复块使用）。
- `slots` 是这个单元要求的槽位名；`vars` 是它读的 CSS 变量。
- `doc` 写"它是什么、什么时候用"，这是给下一个人（或下一个模型）唯一的线索，不要省。

现有单元：

| 前缀 | 覆盖 |
|---|---|
| `paper.*` | 纸纹讲堂：标题、课件台、名牌、人物窗、字幕胶囊、步骤 |
| 笔触原语 | 手绘笔记的笔触在 `vendor/templates/sketchnote/assets/drawing-tools.js`（线、圈、箭头、便利贴、荧光笔） |

数量与逐个单元清单见 [`reference/kit.md`](reference/kit.md)（脚本生成）——正文不写数。

## 写一个单元

在 `vendor/templates/_kit/paper/units/` 下新建一对文件（同名的 `.html` 与 `.css`），
例如 `quote.html`：

```html
<div class="pull-quote">{{props.text}}</div>
```

`quote.css` 放它的声明（只用变量，不要写死会用到的字号）。然后在
`catalog.json` 里登记，最后在某个镜头的 `units` 里引用：

```json
{ "unit": "paper.pull-quote", "props": { "text": "{{copy.quote}}" } }
```

槽位规则（`render.mjs` 里就是这几条）：

- `{{props.x}}` —— 转义后插入；
- `{{{props.x}}}` —— 原样插入 HTML（单元作者显式声明"这里要标记"）；
- `{{copy.x}}` —— 直接读镜头的 `copy`，同样有 `{{ }}` / `{{{ }}}` 两种；
- `{{#if props.x}}…{{/if}}` —— 有值才保留这一块（**不支持嵌套**，需要分支就拆成两个单元）；
- `repeat` —— 一个单元渲染 N 次拼进父单元的槽位：

```json
{ "unit": "paper.steps",
  "repeat": { "unit": "paper.step", "as": "items",
              "items": [{ "num": "1", "title": "放素材", "body": "…" }] } }
```

## 加一个镜头

1. 在 `shots/` 里加 `shot-20.json`（`id` 必须与文件名一致）；
2. `npm run templates:build <模板名>`；
3. `npm run test` —— 会校验标记、样式、选择器、时间轴与"目录自包含"。

镜头墙 `film.html` 是**生成**的：`at` 由前面镜头的时长累加得出，`#t=` 来自镜头
自己的 `duration`。手写这两处曾经对不上（影片能播，只是内容错位），现在不会了。

## 模板目录必须自包含

安装模板是把**整个模板目录复制**进项目（`src/official/official-templates.mjs` 的 `copy`）。
所以页面里不能出现指向模板目录之外的相对路径——例如 `../../_kit/…` 在仓库里能
跑、复制进项目后 404。需要共享的样式由构建器合并成 `<模板>/assets/kit.css`，
且有一条测试扫描每个页面的 `href`/`src` 来守这个边界。

## 模板可选：先搜索，需要时只读一款

- **从零开始**：无需查模板。已有片保留画布，新片优先使用用户指定比例，再参考明确选中的模板，最后用产品默认值。
- **找参考**：`no996_library(kind="template", query="口播", ratio="9:16", category="字幕")` 返回最多 5 个摘要；比例和分类是可选筛选，没有匹配不会退回全目录。分类来自 `tags`，没有明确比例的模板不冒充支持该比例。
- **读详情**：`readTemplate="<id>"` 只读取选中的规格和可选说明，外部文本作为参考数据，不触发项目写入。`take` 对包内模板只记录参考；复制包内完整样片请从 Studio 的新建项目入口操作。

### 新增模板不用改系统提示词

包内完整模板在 `vendor/templates/<id>/`；其 `manifest.json` 包含 `id`、`title`、`entry`、`mode`，目录名要与 ID 一致。建议提供 `description`、`version`、`tags`、`ratios`（如 `["9:16"]`）、`slots` 和 `dependencies`；`prompt.md` 可选，详情只读取有限长度。

从可信渠道解包的外部模板可放在 `~/.openfilm/Templates/<id>/`，由同一工具以 `external:<id>` 发现。当前外部包**只支持检索、读取参考**，不自动下载、预览或复制 HTML/JS 到项目；这些能力需要独立的校验与隔离。OpenFilm 自带多轨素材模板仍通过 `openfilm/` ID 查阅和复用。

模板项目的来源/参考 ID 保存在 `.film/templates.json`。新增、查看和选择不再给项目 `AGENTS.md` 写入模板说明，已存在的旧块与用户指令原样保留。

## 常用命令

```sh
npm run templates:build          # 重新生成所有模板页面与镜头墙
npm run templates:check          # 只校验是否与源一致（不一致退出码 1）
node --test tests/templates-kit.test.mjs   # 模板专项：标记/样式/选择器/时间轴/自包含
```

## 动效风格样片（motion-styles）

与另外三个模板的模型不同：它不做版式拼装，而是把 `vendor/motion/styles/demos/<slug>`
里**上游整片样片**包成 OpenFilm 页面。样片本身就是「给定 t 画一帧」（`window.renderAt`），
所以页面组装器 `_kit/motionstyle/page.mjs` 只做三件事：

1. 把样片要 fetch 的 JSON（`cues.json` 等）内联进页面（`file://` 下 fetch 会被拒绝）；
2. 去掉 `/assets` 字体链接，缺失字体走系统回退（**字形与上游成片不同**，这是已知差异）；
3. 包上 `window.film = { duration, width, height, ready, frame }` 与视口缩放。

两种镜头来源：

1. **直接封装样片**（`style`）：样片能单文件运行时用它，绘制逻辑一行不动；
2. **按 brief 重写**（`scene`）：样片缺素材/要 three.js 时用它，场景文件里用
   `Motion` 的词汇自己画。第二镜（包豪斯）就是这种，见 `shots/shot-02.scene.html`。

```sh
# 封装样片
{ "id": "shot-02", "title": "…", "duration": 10, "style": "01-flat-vector" }
# 自写场景
{ "id": "shot-02", "title": "…", "duration": 8, "scene": "shot-02.scene.html" }
npm run templates:build motion-styles
```

自写场景里 `DURATION` 与 `draw(t)` 是契约：页面外壳会把 `window.film.frame` 转给它。
父层做非整数缩放时记得给文字容器 `will-change: transform`（否则 Chromium 会把字
栅格化成条带再拼接，抽帧能看到横向接缝）。

约束：样片必须能**单文件运行**（内联 module）或只依赖同目录的 JSON。依赖 `js/` 子模块、
`/node_modules`、three.js 的样片（05/07/10/19/22）不能直接搬——先按 `docs/MOTION.md`
的引擎契约决定是内联打包还是重写。

## 已知未做

- `sketchnote/assets/fonts.css` 有 10.4 MB（内嵌字体），未做子集化：影响首屏体积，不影响画面。
