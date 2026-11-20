<!-- doc
id: templates
reader: 做模板的人
fact-source: vendor/templates/**、scripts/templates-build.mjs
checked: 0.19.0
rot-if: 模板结构、_kit、构建流程或提示词注入链路变化
-->

# 模板与素材库

五个随插件发布的模板：首推 **`vibe-explainer`**（Vibe 科普剧场，含 Canvas 2D 物理隐喻与确定性拟音轨），以及 `paper-texture`（纸纹讲堂）、`replica-film`（复刻影片）、
`sketchnote`（手绘笔记）、`motion-styles`（动效风格样片）。前四个是**数据 + 素材单元/场景**
经 `scripts/templates-build.mjs` 生成的产物（支持 `sfxCues` 合成 `.wav` 与双轨无重叠 `<audio>`）；`motion-styles` 是**整片样片**的直接封装
（见文末「动效风格样片」）。

```
vendor/templates/
├── _kit/                     ← 素材库（源）
│   ├── catalog.json          ← 机器可读目录：每个单元的槽位、说明、样式文件
│   ├── render.mjs            ← 组装器：槽位填充、重复块、单元样式与音轨合并
│   ├── motion/motion.js      ← 闭式物理缓动与摇晃/砸入/扫光/接力原语
│   ├── vibe/{vibe-canvas.js,vibe-overlay.js,page.mjs} ← Vibe 原创隐喻画布 + 口播避脸浮层
│   ├── paper/{tokens.css,units/*,page.mjs}
│   ├── replica/units/*
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

## 五个模板的模型不同，不要套用同一套思路

| 模板 | 模型 | 可编辑的东西 |
|---|---|---|
| `vibe-explainer` | **单镜头连续生长剧场（首推标杆）**：共享 `globalT` 世界舞台 + 2.5D 景别运镜 + 6 大生长转场 + 内置《We Never》实测拍点与拟音轨 | `shots/*.json`（文案/色板/时长）+ `stage.js` + `template.json`（`builtinRhythm` / `sfxCues`） |
| `paper-texture` | **静态页 + 避脸浮层**：主页面按需叠加 `VibeOverlay` 透明高亮卡片 | `shots/*.json` 的 `copy`（文案）与 `vars`（字号/位置） |
| `replica-film` | **内容 + 动画**：每个镜头有自己的画面块和 `draw(t)` | `shots/<id>.json` 的 `copy`；`shots/<id>.content.html`（画面块）；`shots/<id>.anim.js`（动效） |
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
| `replica.*` | 复刻影片：主标题、贴纸、纸卡/深色卡、胶囊排、指标、要点列表、场景图标 |
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

## 模板提示词：新增一个模板时，它的提示词怎么注入

模板不只给一份起手的 `film.html`，还带着**自己的设定和思路**：配色、镜头语法、屏上字的口气。
这份东西是 `vendor/templates/<id>/prompt.md`，只进"选了这个模板的那个项目"的对话，不进别人的系统提示。

### 注入链路（一共三步，都是自动的）

```
1. 选中        no996_library(kind=template, take=<id>)
                 ↓
2. 记住        <项目>/.film/templates.json   { "version": 1, "active": ["sketchnote"] }
                 ↓
3. 写进去      <项目>/AGENTS.md 里的生成块：
               <!-- no996-openfilm:templates:begin -->
               ## 本片使用的模板
               ### 手绘笔记（sketchnote）
               <prompt.md 的内容>
               <!-- no996-openfilm:templates:end -->
```

第 3 步只在项目指令文件字节内容可确认为本插件生成的版本时执行；本人创建或修改过的 `AGENTS.md` 整个保持原样，哪怕其中有生成块标记也不改。插件记录上一次生成文件的哈希以识别后续同步；无法确认归属时跳过写入。原生 DSH 会话可在之后读取成功写入的文件；当前轮同时在工具结果返回模板提示词，跳过同步时也明确告知。

### 加模板时你要做的

| 步 | 做什么 | 硬要求 |
|---|---|---|
| 1 | 建目录 `vendor/templates/<id>/` | `<id>` 是 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`，与 `manifest.json` 的 `id` 一致 |
| 2 | `manifest.json` | 必填 `id`/`title`/`entry`/`mode`（`film` 或 `style`）；建议 `description`、`prompt`（一句话）、`tags`（可搜） |
| 3 | `prompt.md`（新增模板必备；旧模板允许缺省） | 建议不超过 2 KB，写**这支片的设定与思路**。代码按 2048 个 JavaScript 字符截断，不是字节硬限制；不要写通用剪辑教程 |
| 4 | `film.html` + 素材 | 目录必须自包含（上文） |
| 5 | 跑 `npm run check` | 模板清单、提示词长度、链接都有测试 |

不需要注册表：`src/film/template-catalog.mjs` 扫目录读 `manifest.json` 与 `prompt.md`。
`no996_library(kind=template, query="…")` 按 `id/title/description/tags` 搜（含不加班模板与官方 14 个多轨模板）。

### 多个模板可以叠加

- `.film/templates.json` 的 `active` 是顺序；生成块按这个顺序渲染，先写的先出现。
- 生成块使用 8192 个 JavaScript 字符的段落预算，单个 prompt 按 2048 个 JavaScript 字符截断；超出预算的后续模板不渲染（不报错，但会在结果里少了那一段）。
- 取消启用：从 `active` 里删掉那个 id（或写空数组），下次 `prepareProject` 会把那一段从生成块里移除。
- 冲突时以**后出现的模板 + 用户当轮的话**为准，这条写进了生成块的开头。

### 不要做

- 手改项目指令后插件不再自动覆盖它；需要更新模板说明时，请在工具结果中查看并由项目所有者自行调整。
- 不要把模板提示词塞进工具描述或 persona：常驻预算只有 6 KB（persona + 指令文件），模板是"选了这个项目才有"的信息。
- 不要把 `prompt.md` 写成模板的 README（安装步骤、构建命令属于 `docs/TEMPLATES.md`，不属于对话）。

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
