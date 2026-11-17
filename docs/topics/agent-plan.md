<!-- doc
id: agent-plan
reader: 设计提示词与对话行为的人、维护对话桥的人
fact-source: dsh --profile acp --dump-config、src/project/project-instructions.mjs、src/official/official-facade.mjs、acp-agent-service.mjs、src/*-tool.mjs、skills/
checked: 0.15.21
rot-if: ACP 会话键、注入链（persona/AGENTS.md/技能）、影片工具面或模板库变化
-->

# 把"写代码的 agent"改成"剪辑导演"——注入链现状与升级方案

> 这篇回答三个问题：**它现在到底看到了什么提示词**、**为什么它说的话跟剪片无关**、**要让它真的会剪片该怎么做**。
> 全部结论都有代码或命令作证据；没验证的地方标"未验"。

## 0. 实现状态（0.15.21）

| 批次 | 状态 | 落点 |
|---|---|---|
| P0-1 会话按对话隔离 | **已实现**（单测；面板未验） | `acp-agent-service.mjs`、`acp-session-store.mjs`、`src/official/official-facade.mjs` |
| P0-2 影片库移出仓库 | **已实现** | 默认目录 `~/Videos/OpenFilm/Projects`；注入链修复见 P0-2' |
| P0-2' 仓库手册不再注入 | **已实现** | `src/native/openfilm-persona.mjs`（`.film`/`film.html` 根标记） |
| P0-3 persona 换成剪辑导演 | **已实现**（`--dump-config` 验证） | 同上 |
| P0-4 注入自检 | **已实现** | `/diagnose.instructions`（persona、逐文件字节、budget） |
| P1 分镜契约 | **已实现**（`read/write/plan/from-script/subtitles`） | `src/film/storyboard.mjs`、`src/tools/storyboard-tool.mjs`、`skills/openfilm-director` |
| P1-3 导演技能 | **已实现** | `skills/openfilm-director/SKILL.md` |
| P2 口播优先 | **已实现**（转写→句子→镜头→字幕，纯函数） | `src/film/script-plan.mjs` |
| P3 模板可发现 | **已实现**（目录 + `prompt.md` 按需） | `src/film/template-catalog.mjs`、`openfilm_library kind=template` |
| P4 上下文预算 | **已实现**（常驻 ≤ 6 KB 可查） | `/diagnose.instructions.budget` |
| 从分镜自动建时间轴 | **未做**（缺片段创建接口） | 见 §8 与 `ROADMAP` |
| L2 每轮项目摘要注入 | **未做**（改为按需读 `openfilm_film`/分镜） | 见 `ROADMAP` |

决定与代价见 [ADR-0011](../decisions/ADR-0011-director-contract.md)。

## 1. 一句话结论

面板里的 agent 现在是 **DSH 的通用编码 agent**，不是剪辑 agent：它的身份提示词写着"你是一个编码 agent"，它读到的第一份项目说明是**本插件仓库的开发者手册**，而剪辑说明只是排在后面的第二份。所以它会复述"仓库、0.15.x、四层界面、补丁"——那不是它幻觉，是它真的读到了。

## 2. 现在实际注入了什么

`dsh --profile acp --dump-config` + `@deepseek-ai/dsh-agent-instructions` 的加载规则，一共四层：

| 层 | 内容 | 从哪来 | 大小 | 剪辑场景该不该在 |
|---|---|---|---|---|
| **身份** | `You are a coding agent powered by the {{model}} model.` | `system-prompt.personaPrefix`（`dsh-acp-app` 覆盖 `dsh-base`） | ~60 B | ❌ 这是"编码 agent" |
| **工具说明** | 内置工具 + 11 个 `openfilm_*` 工具 + MCP 描述 | `dsh-base` + `mcp-server.mjs` | 数 KB | ✅ |
| **指令链** | `$DSH_HOME/AGENTS.md` → `<项目根>/AGENTS.md` → `<cwd>/AGENTS.md`（按 `.git` 找项目根，从宽到窄） | `dsh-agent-instructions`，`maxBytes: 65536` | 仓库手册 ~9 KB + 项目说明 ~2 KB | ⚠️ 仓库那份完全不该在 |
| **技能** | `openfilm-motion`、`openfilm-editing` 等 | `dsh-skill` + `dsh-skill-filesystem` + `tool-skill` | 按需（调 `skill` 才读） | ✅ 但默认不加载 |

### 2.1 图 2 的来源，逐条对上

截图里它说"F:\Dev\Desktop-Projects\dsh-openfilm 是一个 DSH 插件…0.15.15…MIT…把官方 OpenFilm 0.3.2 整体封装进 DSH…Host 回环启动 Studio…四层界面"——**逐句都能在仓库 [`AGENTS.md`](../AGENTS.md) 里找到**（§0 一句话、§2 四层界面）。版本号 0.15.15 是当时的版本，说明它读到的是那一版文件。

原因是路径：

```
影片库  F:\Dev\Desktop-Projects\dsh-openfilm\films\Projects\自定义-7f8dfa
        └─ 项目根（有 .git）  F:\Dev\Desktop-Projects\dsh-openfilm   ← 仓库手册在这里
```

`dsh-agent-instructions` 用 `.git` 标记项目根，把**从项目根到 cwd 的每一层** `AGENTS.md` 都注入。影片库放在插件仓库里，于是"改插件的人"的手册进了"剪片的人"的提示词。项目自己那份 `AGENTS.md`（[`src/project/project-instructions.mjs`](../src/project/project-instructions.mjs) 写的）排在它后面，权重更小。

它为什么还去读 `.film/`、`assets/`、`.codegraph/`？因为工具权限允许，且项目说明第 1 条写着"先读再改"。它没有"该读什么"的边界——那正是下面要补的。

### 2.2 顺带确认的两件事

- `~/.dsh/AGENTS.md`、`~/.agents/AGENTS.md` 都不存在，所以没有额外的用户级污染。
- 技能是**装了但没被加载**：`skill` 工具在，模型得主动调才读 `SKILL.md`；当前没有任何规则要求它做片前先读 `openfilm-motion`。

## 3. 三个"串台"问题的实际结论

### 3.1 两个"正在思考"——已修

两个不同的组件在画同一句话：

| 组件 | 什么时候出现 | 截图里是哪一行 |
|---|---|---|
| `ThoughtRow` | 有思考文本且 pending | 上面那行「正在思考 ⌄」 |
| `StatusLine` → `pendingWork()` 把 `kind:'thought' && pending` 也算成"在干活" | 同时 | 下面那行「正在思考」+ 秒表 |

修法：`StatusLine` 不再把思考算进状态行（思考自己有行、自己有时钟）。已进 `patches/020-AgentActivityRow.patch`，需重启 Studio 生效。

### 3.2 新建会话会把上一轮带进来——真 bug，未修

事实链：

1. 页面每个对话有自己的 id（`ProjectSessionItem.id`）和"agent 的会话 id"（`agentSessions[agent]`），`App.tsx` 每轮把 `conversation`/`resume` 交给桥；
2. 桥（[`src/official/official-facade.mjs`](../src/official/official-facade.mjs) `start`）把 `resume` 当作对话 id 回给页面，但 **Host 侧只用 `projectId`**：`agentKeys.set(key, projectId)`；
3. [`acp-agent-service.mjs`](../acp-agent-service.mjs) 的 `entryOf(projectId)` 一个项目**只有一个** ACP 会话，`send()` 用的是 `entry.sessionId`；
4. 所以：**同一项目下所有对话共用一条 DSH 会话**。新建对话 = 接着上一轮聊，历史、思考、工具调用全在。

这不是"记住了不该记的"，是**根本没实现按对话分会话**。修法在 §6 P0-1。

### 3.3 思考里冒出仓库内容——同 §2，注入链问题

## 4. 目标形态：一个"剪辑导演"，不是一个"会剪片的编码 agent"

一句话：**它应该先问"这支片要干什么"，再决定"用什么镜头、什么动效、什么节奏"，最后才动 `film.html`。**

对应的四层提示词，每层有主、有预算、有加载时机：

| 层 | 内容 | 谁负责 | 预算 | 何时在上下文里 |
|---|---|---|---|---|
| **L0 身份** | 你是 No996 Studio 的剪辑导演；你交付的是**能播的片子**，不是代码 | `personaPrefix`（`--patch` 覆盖） | ≤ 400 B | 永远 |
| **L1 工作协议** | brief → 口播时序表 → 分镜 → 定调帧 → 量产 → 声音 → 帧检 → 导出；每步一行说明；不中途问"要不要继续" | 项目 `AGENTS.md`（改写现有那份） | ≤ 3 KB | 永远 |
| **L2 项目事实** | 这支片有什么素材、时长、已有时序表、当前风格 | Host 生成，随每轮首条消息注入（见 P0-3） | ≤ 1.5 KB | 每轮 |
| **L3 按需知识** | `openfilm_guide` 手册、`openfilm_library` 库、`skill` 技能、模板说明 | 工具调用 / 技能加载 | 不常驻 | 用到才读 |

**反模式（现在正在犯的）**：把 14 种风格、124 张镜头卡、模板清单全塞进系统提示——那是几万 token，每轮都付，而且模型会开始"背目录"而不是干活。

## 5. 注入逻辑该怎么写

现在的注入是"DSH 默认行为 + 一份项目文件"，改造后要变成**显式、可查、可关**：

```
每次会话启动
  ├─ personaPrefix（L0）            ← --patch 覆盖，随插件版本走
  ├─ 项目 AGENTS.md（L1）            ← 我们的模板，写一次，人可改
  ├─ L2 项目摘要                     ← Host 每轮生成（素材/时长/时序表/风格）
  └─ 指令链里**屏蔽**仓库 AGENTS.md  ← 见 P0-2
用到时
  ├─ openfilm_guide(topic)          ← 手册
  ├─ openfilm_library(query)        ← 库（转场/特效/贴纸/文字/音乐/模板）
  ├─ openfilm_transcribe(from)      ← 口播时序表
  └─ skill('openfilm-motion')       ← 生产协议 + 动作词汇
```

三条硬规则：

1. **一个事实只有一个来源。** 模板清单在库里，不在提示词里；风格在技能里，不在项目说明里。
2. **每层可关。** `NO996_OPENFILM_BRIEF=0` 关 L2，便于对比"没有摘要时它会不会乱读目录"。
3. **可自检。** `/diagnose` 返回"这一轮实际注入了哪些文件、各多少字节"（现在只能靠猜）。

## 6. 方案：五个批次

### P0 止血（先让它别认错身份、别串会话）

| # | 做什么 | 改哪 | 验收 |
|---|---|---|---|
| P0-1 | **ACP 会话按对话键**：`agentKeys` 记 `{projectId, conversation}`；`entryOf(projectId+conversation)`；新对话 → `session/new`，老对话 → `session/resume`（页面已有 `agentSessions`）。tap 帧按 `sessionId` 路由到对应对话 | `official-facade.mjs`、`acp-agent-service.mjs`、`acp-client.mjs` | 新建对话后第一句问"我们刚才聊了什么" → 它答不知道；回到旧对话 → 答得出 |
| P0-2 | **影片库默认移出仓库**：默认目录改成 `%USERPROFILE%\Videos\OpenFilm\Projects`（这台机器已有该目录）；仓库内的 `films/` 只给开发自测，并在那里放一份 `AGENTS.local.md` 说明"这是测试数据" | `src/*` 默认路径 + 首次安装引导 | 新项目 → `/diagnose` 的注入清单里**没有**仓库 AGENTS.md |
| P0-3 | **personaPrefix 覆盖**：`--patch` 把 L0 换成剪辑导演（复用 tap 的覆盖层机制，失败只丢它、不影响会话） | `acp-agent-service.mjs` 的 `spawnArgs` | 问"你是谁" → 答剪辑导演，不提"coding agent" |
| P0-4 | **注入自检**：`/diagnose` 增 `instructions: {files, bytes, persona}` | `diagnose.mjs` | 一眼看出注入了哪几份、多大 |

### P1 导演协议（让它先想再动手）

| # | 做什么 | 验收 |
|---|---|---|
| P1-1 | **`storyboard.json` 契约**：一份可校验的分镜表（镜头/时长/景别/动效/文案/音效），落在项目 `.film/storyboard.json`；`openfilm_clip` 能直接读它批量建轨 | 给它一句话 brief → 它先产出 storyboard.json，再按表建轨 |
| P1-2 | **`openfilm_storyboard` 工具**：写/读/校验分镜表，schema 拒绝越界（时长、轨道、素材路径） | 非法分镜被工具拒绝并给出原因 |
| P1-3 | **`openfilm-director` 技能**：把"brief → 分镜 → 定调帧 → 量产"写成可加载的 SKILL.md，替代现在塞在项目说明里的散文 | 做片时会主动 `skill('openfilm-director')` |

### P2 口播优先（用户丢视频过来，第一件事是转写）

现有能力已经够跑通，缺的是**协议**和**一步到位**：

| 步骤 | 现在 | 要补 |
|---|---|---|
| 抽音频 + 转写 | `openfilm_transcribe` 已有：ffmpeg 抽 16 kHz 单声道、SenseVoice int8、按内容指纹缓存、500 MB 视频不进 Node 堆 | — |
| 时序表 | 工具返回带 start/end 的段落 | 落成 `script.json`（句/时间码/字数） |
| 切点 | 无 | 按停顿 + 句边界生成候选切点，写进分镜表 |
| 字幕轨 | 无 | 一句一条字幕，`openfilm_clip` 批量建轨 |
| 粗剪 | 无 | 按分镜表生成第一版时间轴，再让模型"看帧"调 |

验收：给一段 5 分钟口播视频 → 它先出时序表（不是先问"你想怎么剪"）→ 出分镜表 → 出一版可播的粗剪。

### P3 模板与动效的可发现性

| # | 做什么 | 验收 |
|---|---|---|
| P3-1 | **模板清单进库**：`openfilm_library(kind:'template')` 返回每个模板的一句话 + 适用场景，不返回内容 | 问"适合知识口播的模板" → 命中 2–3 个 |
| P3-2 | **模板专属提示片段**：`vendor/templates/<name>/prompt.md`，被选中模板时才注入（≤ 800 B） | 选模板后它按该模板的版式建议走 |
| P3-3 | **动效按需**：风格名 + 镜头卡 id 由技能按需读，系统提示里只留"有 14 种风格"一句 | 系统提示不随风格数量增长 |

### P4 上下文效率（持续）

- 目标：常驻 ≤ 6 KB（L0+L1+L2），其余全靠工具。
- 每轮结束记 `context: {instructions, brief, tools, skills}` 到 `/diagnose`，超预算报警。
- 长会话压缩：口播全文不重复注入，只注入"已用时序表 N 段、当前在第 M 段"。

## 7. 预算表（拍板用）

| 层 | 目标 | 现在 |
|---|---|---|
| L0 身份 | 400 B | ~60 B，但内容是错的 |
| L1 工作协议 | 3 KB | ~2 KB（项目说明） |
| L1' 仓库手册 | **0** | ~9 KB（不该有） |
| L2 项目摘要 | 1.5 KB | 0（靠模型自己读目录） |
| L3 技能/库 | 按需 | 0（从不主动读） |
| 合计常驻 | **≤ 6 KB** | ~11 KB，且一半是噪音 |

## 8. 不做什么

- 不把 124 张镜头卡、14 种风格、模板全文写进系统提示。
- 不用"更长的提示词"解决"没做对"，先修会话键和注入链。
- 不让 agent 自己删素材、改原始文件；导入用 `openfilm_assets`。
- 不承诺预览/渲染已接通——没接通。

## 9. 验收总表

| 项 | 怎么一眼看出 |
|---|---|
| 身份对了 | 问"你是谁" → 剪辑导演，不提 coding agent |
| 注入干净了 | `/diagnose` 的 `instructions` 里没有仓库手册 |
| 会话分开了 | 新对话问上文 → 不知道；旧对话 → 知道 |
| 先转写后剪 | 丢视频 → 第一件事是时序表，不是问"你想怎么剪" |
| 先分镜后动手 | 有 `storyboard.json` 才建轨 |
| 上下文不膨胀 | `/diagnose` 的常驻字节数 ≤ 6 KB，且不随模板/风格数量涨 |
