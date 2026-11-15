<!-- doc
id: status
reader: 所有人（"现在到哪了"）
fact-source: package.json 的 version、CHANGELOG.md、git log、playbooks/manual-acceptance.md 的待验项
checked: 0.15.11
rot-if: 每次发版、每个批次结束、任何"待验"变"已验证"
-->

# 状态

> **唯一允许写"进度"的地方**（另两个是 `ROADMAP.md` 与 `CHANGELOG.md`）。
> 版本号不手写：`npm run status:check` 会拿 `package.json` 核对本文件。

## 1. 版本

| 项 | 值 |
|---|---|
| 仓库版本 | **0.15.21**（`package.json`） |
| 最近发布包 | 0.12.1（据 `AGENTS.md`；发版前在 Releases 页核对一次） |
| 运行基线 | DSH 0.15.x、Node ≥ 22.8 |

## 2. 这一批做完了什么（0.15.1）

- 剪辑区：搜索、删除对话/清空对话/删除项目（回收站 + realpath 与 `.film` 校验）、静默刷新。
- 视觉收口：内联 SVG 图标、圆点选中态、菜单/弹窗/toast 入场动效，`prefers-reduced-motion` 关闭。
- 工程：CI 在 Windows runner 上跑绿（12 步全过，2026-11-14 首次）；零依赖 lint、`npm test`/`npm run check`/`npm run release:check` 入口、`dist/` 二进制出库、行尾统一 LF。
- 文档：本文件与 `docs/index.md`、`decisions/`、`reference/`、`playbooks/` 落地（ADR-0007）；动效三篇合一（`MOTION.md`，后两节生成），数量统一由 `reference/kit.md` 生成；正文写死的仓库路径纳入 doclint。
- 结构：代理/控制器抽出 10 个模块，路由注册表 14/14 迁完（ADR-0008），控制器 1,558 → 1,037 行；每个路由组都有行为测试。

### 2.1 真流式重做（0.15.19，ADR-0010）

- **根因**：模型覆盖层与 tap 覆盖层共用 `spawnArgs` 的一个数组，模型被拒时的重试把 tap 一起丢了；日志里 `acp-stream-connected` 全程只出现一次，且属于一个随即被替换的子进程。
- 覆盖层按用途拆成 `{model?, tap?}`，回退只丢模型；tap 连上先发 `hello`（`acp-stream-hello`）。
- 帧契约：`start`/`delta`/`sync`/`seal` 带 `attempt` 与 `index`；`sync` 约 250 ms 一次，把丢帧的修复窗口从"回合结束"缩到 250 ms。
- 页面（`patches/190-local-agent-run.patch`）：按 attempt 认领行，提交时 `claimAttempt` 接管（行 id 不变）；`delta` 追加、`sync`/`seal` 覆盖；store 通知按 `requestAnimationFrame` 合并。
- 可观测：每轮 `acp-stream {deltas, seals, syncs, textCommits, connected}`；有文本提交却零 delta 时 `acp-stream-silent`；`/diagnose` 的 `turns.stream` 给同样三项。
- 顺手修掉 `chat-store.ts` 的既有类型错误，上游 `pnpm --filter @openfilm/desktop typecheck` 重新为绿。

### 2.2 叠字与"思考串台"（0.15.20，同一份 ADR）

- **根因**：`sync`/`seal` 绕过 30 ms 的 delta 队列直接写 socket，快照先到、被它概括的 delta 后到，
  页面把同一段写两遍；换轮时补发的旧 `seal` 又把上一轮思考写进新消息开头。真机帧序列离线重放：
  旧顺序文本 340 字符（提交值 95）、思考 470（提交值 181）；新顺序两者都与提交一致。
- tap 所有帧走同一条有序队列；换轮只清空思考、不 seal；思考改在 attempt 结束时 seal（仍在同一轮内）；帧带 `turn`。
- 页面用 `preferLonger` 覆盖快照（绝不拼接），并丢弃比当前轮更旧的帧。
- 思考行默认收起，展开后最高 280px、内部滚动（`patches/020-AgentActivityRow.patch`）。
- 新增 `tests/acp-stream-tap.test.mjs` 钉住顺序契约。

### 2.3 剪辑导演（0.15.21，ADR-0011）

- **一条对话 = 一条 ACP 会话**：`conversation` 随 agent RPC 走到 Host，子进程内按对话 `session/new` / `resume`；
  会话 id 按对话存在 `acp-sessions.json` v2（v1 自动迁移）。修复"新建对话接着旧对话聊"。
- **身份**：persona 覆盖成"剪辑导演"（≤ 400 B）；**指令边界**：`.film`/`film.html` 作为项目根标记，
  影片文件夹之上的 `AGENTS.md` 不再注入；默认影片库移到 `~/Videos/OpenFilm/Projects`。
- **分镜契约**：`openfilm_storyboard`（read/write/plan/from-script/subtitles），`.film/storyboard.json`；
  `plan` 输出 `openfilm_clip` 操作并列出缺片段的镜头；口播 → 分镜 → 字幕（SRT）走纯函数。
- **模板可发现**：`openfilm_library kind=template` + 每模板 `prompt.md`（按需读）。
- **预算**：`/diagnose.instructions.budget` 常驻 ≤ 6 KB。

## 3. 进行中

无。下一批见 [`ROADMAP.md`](ROADMAP.md)。

## 4. 待真机验证（源码完成 ≠ 可以用）

| 项 | 证据等级 | 怎么验 |
|---|---|---|
| 会话隔离（0.15.21）：新建对话不带上一轮、回到旧对话还在 | 单测：两个对话两条 ACP 会话、重启后各自 resume；面板实机未看 | 在同一项目里开两个对话各说一句，再互相问"刚才说了什么"：都只知道自己那条 |
| 剪辑导演身份（0.15.21）：问"你是谁"答剪辑导演，不复述仓库 | `--dump-config` 验证 persona 与根标记生效；`/diagnose.instructions.outside` 列出被排除的仓库手册；面板实机未看 | 问"你是谁""这是哪个仓库"：不应出现版本号/MIT/四层界面 |
| 分镜（0.15.21）：先出分镜再动时间轴 | 单测：校验/plan/口播切镜/字幕；面板实机未看 | 丢一段口播视频：先转写，再出 `.film/storyboard.json`，`op=plan` 的 `missing` 说清缺什么 |
| 真流式（0.15.20）：字连续长出来、不叠字、思考不串到下一轮 | 真子进程帧序列离线重放：新顺序的文本/思考与提交值完全一致；Host 单测覆盖顺序、换轮、tap 缺失；面板实机未看 | 跑两三轮：每段只出现一次；上一轮的思考不出现在新消息里；点开「思考了 Ns」正文最高 280px 可滚动。日志：`acp-stream-hello` 出现、每轮 `acp-stream.deltas > 0`、无 `acp-stream-silent` |
| 一行思考 / 产物图只一张（0.15.18） | 源码 + 离线通过，实机未看 | 一个带工具调用的回合：思考只有一行「思考了 Ns」，产物图只一张 |
| ACP 面板：刷新页面后发一句 → 侧栏同一会话 | 源码 + 离线集成通过 | [`playbooks/manual-acceptance.md`](playbooks/manual-acceptance.md) 第 11 步 |
| 删除项目：壳里删 → 进回收站 → 恢复 | 单测通过 | 手动删一个空项目再恢复 |
| 登录一次、退出、再打开应免登录 | 单测 + 离线 | 首次安装 → 登录 → 做一支片 → 退出 → 重开面板 |
| 首次打开的两处引导：①选影片类型的四张卡 ②编辑器里的空态/拖放提示 | 源码完成 | 覆盖安装后第一次打开面板；只想看界面：`npm run onboard:preview`（打桩，不起真 Studio） |
| 账号余额展示 | 未实现 | — |

## 5. 已知边界（不是 bug）

- 官方输入框在部分场景只读；默认权限不是完全访问。
- 预览/渲染沙箱未接；`openfilm_draft` 只是内存草稿。
- macOS/Linux 未做真机验收（仓库只在 Windows 验证过）。
- 侧栏「工作区」标题行的所有改动都是窄注入（见 `reference/injection-registry.md`）。

## 6. 怎么更新这篇

发版或批次结束时手改 §1/§2/§3；§4 只增不减，除非有真机证据；§5 变了先改 `reference/safety.md` 再改这里。
