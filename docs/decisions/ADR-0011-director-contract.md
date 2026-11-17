<!-- doc
id: adr-0011-director-contract
reader: 设计对话行为、提示词、影片工具的人
fact-source: src/film/storyboard.mjs、src/film/script-plan.mjs、src/native/openfilm-persona.mjs、acp-agent-service.mjs
checked: 0.15.21
rot-if: ACP 会话键、分镜 schema、口播转写接口或工具面变化
-->

# ADR-0011：一个项目多对话 = 多条 ACP 会话；剪辑先有分镜，再动时间轴

- 状态：生效（0.15.21；面板实机验收见 `docs/STATE.md`）
- 日期：2026-11-15
- 取代：无（补充 ADR-0010 的对话边界；新增分镜契约）

## 1. 背景：三个症状，一个根

用户报了三件事：新建对话会把上一轮带进来、两个"正在思考"、agent 讲的东西跟剪片无关（复述仓库版本号与四层界面）。前两个是界面与会话键的 bug，第三个是注入链的 bug。它们看起来无关，但都指向同一句话：**面板里的对话没有"这是一支片"的边界。**

- 会话边界：Host 侧 `entryOf(projectId)` 一个项目只有一条 ACP 会话，页面的对话 id 与 `resume` 从未到达 Host；
- 身份边界：子进程的 persona 是 `You are a coding agent`（acp profile 的默认）；
- 指令边界：`dsh-agent-instructions` 用 `.git` 找项目根，影片库在插件仓库里 → 仓库手册进了影片对话。

## 2. 决定一：一条对话 = 一条 ACP 会话（同一个子进程）

一个项目一个 `dsh --profile acp` 子进程（MCP 令牌、tap、模型菜单都是进程级的），**会话按对话分开**：

- `sessionOf(child, conversation)`；`conversation` 来自页面自己的对话 id，Host 只当它是不透明键；
- 新对话 → `session/new`；回到旧对话 → `session/resume`（id 存在 `~/.dsh/no996-openfilm/acp-sessions.json` 的 `sessions[conversation]`，v2 格式，v1 自动迁移成默认对话）；
- 帧与提交按 `sessionId` 路由回各自的对话，`emit` 的 `key` 仍是页面的 turn key；
- 权限请求不带 sessionId，按"当前跑着的那条会话"回答。

**为什么不一个对话一个子进程**：每个子进程要自己的 MCP 令牌，而 `onClosed(projectId)` 会吊销整个项目的令牌——第二个对话一开，第一个的令牌就没了。多进程还会让内存随对话数线性增长。

**代价**：同一项目里两个对话同时跑时，权限请求只能归到"最近发起的那一条"；DSH 的 ACP 适配器本身也是串行的，可接受。

## 3. 决定二：身份与指令边界写在子进程配置里

- persona 用 `--patch` 覆盖 `system-prompt.personaPrefix`（≤ 400 字节，只说"你是剪辑导演、交付能播的片"）；
- `agent-instructions.projectRootMarkers` 增加 `.film` 与 `film.html`：**每个 OpenFilm 项目天然带这两个标记**，于是指令链从影片文件夹开始，仓库手册不再进来（`/diagnose` 的 `instructions.outside` 会把本该被排除的文件列出来，回归一眼可见）；
- 两个覆盖层与 tap 一样"永不因模型回退被丢掉"，只有模型覆盖层是可选可丢的（ADR-0010 §2.5 的教训）。

**不改用户目录、不建 `.git`**：修的是"读什么"，不是"把影片库搬走"。新建项目的默认目录改成 Studio 自己的位置（`~/Videos/OpenFilm/Projects`），已有项目原样不动。

## 4. 决定三：分镜是契约，时间轴跟着它走

`.film/storyboard.json`（`src/film/storyboard.mjs`）：

```json
{ "version": 1, "duration": 45.5, "shots": [
  { "id": "s1", "from": 0, "to": 4.2, "clip": "clip-3", "in": 1.0, "out": 5.2,
    "kind": "talking-head", "motion": "push-in", "caption": "今天讲三件事" } ] }
```

- 工具 `openfilm_storyboard`：`read` / `write`（校验：不重叠、不倒序、id 不重复、motion 在词汇表内）/ `plan` / `from-script` / `subtitles`；
- `plan` 把分镜翻译成 `openfilm_clip` 的 `trim`/`move`，**并明确列出还缺片段的镜头**——`openfilm_clip` 加不了片段，假装能加才是撒谎；
- 口播优先：`openfilm_transcribe` → `op=from-script` 按句切镜（不在句中切）→ `op=subtitles` 出 SRT；
- 同一份输入永远给同一条切法（纯函数），所以"重跑一次"是可复核的，而不是又一支新片。

## 5. 代价与不做的事

- 分镜 schema 故意小：帧、缓动、调色参数都不进分镜，时间轴能算的就不写进来。
- 模板与技能**按需读**（`openfilm_library kind=template`、`skill('openfilm-motion')`），不进系统提示；常驻预算 ≤ 6 KB（`/diagnose` 的 `instructions.budget`）。
- 不实现"从分镜自动建时间轴"：那需要 OpenFilm 的片段创建接口，目前只有 Studio 的 UI/`/api/get`。`plan` 的 `missing` 是这条路的诚实出口。
- 未验：面板里两个对话的实际隔离、persona 的实际回答、分镜到时间轴的实际执行——都只有离线证据。
