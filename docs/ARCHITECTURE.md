<!-- doc
id: architecture
reader: 开发者、智能体
fact-source: index.js、cordis.patch.yml、src/native/dsh-native-agent-service.mjs、src/film/template-prompts.mjs
checked: 0.16.1
rot-if: 进程模型、对话边界、预设/模板注入方式变化
-->

# 架构：OpenFilm × DSH 原生直连

> 只写“系统长什么样、边界在哪”。进度在 `docs/STATE.md`；历史 ACP 边车方案保留在 `feat/acp-chat` 分支。

## 1. 总体架构：Host 进程内直连 `ctx.sessionController`

```text
┌─────────────── OpenFilm 面板（官方壳，iframe） ───────────────┐
│  左侧：Studio 时间轴 / 画布 / 预览                            │
│  右侧：聊天 UI ← SSE /__dsh/official-events & RPC             │
└───────────────────────────────▲──────────────────────────────┘
                                │ Host 进程内直接适配（零子进程）
┌───────────────────────────────┴──────────────────────────────┐
│ dsh-no996-editor（DSH Cordis 插件，运行在 DSH Host 进程内）       │
│  ├─ dsh-native-agent-service：直连 ctx.sessionController      │
│  │    · create({ workspaceId, agentPreset: 'openfilm-video-editing' })
│  │    · prompt / follow(assistantStream: true) / cancel       │
│  │    · selectModel / modelCatalog / projections              │
│  ├─ preset-openfilm-video-editing（cordis.patch.yml）：       │
│  │    · persona（剪辑与动效搭档）+ openfilm-prompt + openfilm-skills │
│  │    · agent-instructions（projectRootMarkers: .film/film.html）
│  │    · skill-filesystem（includeDefaultRoots: false）         │
│  └─ openfilm_* 工具：进程内直调（isProjectAgent 按 sessionId 鉴权）
└──────────────────────────────────────────────────────────────┘
```

## 2. 关键设计机制

### 2.1 会话与工作区边界
- **一条对话 = 一条原生 DSH 会话**：映射保存在 `$DSH_HOME/no996-openfilm/native-sessions.json`（`projectId + conversation -> sessionId`）。
- **专属 Workspace 承载 + 侧栏视图隔离**：新建会话优先绑定影片根目录对应的唯一 `workspaceId`；同时 [sidebar-editing.mjs](../src/ui/sidebar-editing.mjs) 在 DSH「工作区」视图下自动隐藏剪辑专属文件夹与所有 `hiddenSessionIds`，剪辑对话统一收口在左侧「剪辑区」内展示。
- **不抛误导性 503**：429 限流、冷却期等模型/回合业务错误仅通过 SSE `done: { ok: false, error }` 在聊天框内提示，不再触发底部全局 HTTP 503 红条。

### 2.2 预设联动、指令链与模板提示词注入
1. **预设与 Skill 隔离**（[cordis.patch.yml](../cordis.patch.yml)）：
   - `preset-openfilm-video-editing` 内置 `@deepseek-ai/dsh-persona`（剪辑与动效搭档人设）、`@newbiecheng/dsh-no996-editor/openfilm-prompt`、`@newbiecheng/dsh-no996-editor/openfilm-skills`（仅注册 `skills/` 下的 `openfilm-director`、`openfilm-editing`、`openfilm-motion`），并设 `skill-filesystem.includeDefaultRoots: false`，彻底隔离全局无关 Skill。
   - `agent-instructions` 配置 `projectRootMarkers: ['.git', '.film', 'film.html']`，保证影片文件夹自身就是指令根，仓库/单仓上层的 `AGENTS.md` 不进入影片对话。
2. **模板专属提示词注入**（[template-prompts.mjs](../src/film/template-prompts.mjs)）：
   - 每个视频模板可在 `vendor/templates/<id>/prompt.md`（≤ 2 KB）定义自己的“设定、节奏、镜头与屏上字规矩”。
   - 链路：
     ```text
     openfilm_library(kind=template, take=<id>) / 创建模板项目
       → <项目>/.film/templates.json   { "active": ["sketchnote", …] }
       → 仅当文件可确认为插件所有时更新 <项目>/AGENTS.md 的生成块
       → 当轮从工具回执读取；后续会话读取成功同步的指令文件
     ```
   - 支持多模板叠加（按 `active` 顺序渲染，整块上限 8 KB）；不写死在全局 `persona` 中，只作用于选了该模板的当前项目。

### 2.3 流式、工具展示、上下文占用与自动压缩
- **流式与思考收口**：`follow({ assistantStream: true })` 实时下发 `text-delta` / `reasoning-delta`（`end` 帧带 `seal: true` 防重复拼接），并在 `assistant/message` 下发权威 `agent_message_chunk`，由前端 `claimAttempt` 接管并将「正在思考」收口为「思考了 Xs」。
- **全量工具行**：`mapToolCallForUi` 将 DSH 原生工具（`pwsh` / `bash` / `read` / `glob` / `grep` / `write` / `edit` / `web_search` / `web_fetch` / `skill`）与 `openfilm_*` / `openfilm_cli` 统一映射到持久化的 `ActRow`，并透传精简 `rawOutput`。
- **上下文占用与自动压缩**：
  - 从 `follow()` 初始 `snapshot.projections` 及每轮 `sessionController.projections({ sessionId })` 读取 `contextPressure`（`contextWindow`、`projectedTokens ?? pressureTokens`），实时推送 `usage_update` 驱动底部 `ContextUsage` 圆环与 85% 预警高亮；
  - 监听 DSH 宿主自动压缩事件 `compaction/start` → `compaction/end`，向面板展示压缩活动行并在压缩完成后刷新占用百分比。

### 2.4 DSH 工具与 OpenFilm 媒体能力共存
- **工具分工**：DSH 原生工具负责联网检索（`web_search`/`web_fetch`，依赖宿主 `ctx.web` 提供商如 `web-search-deepseek`）、通用文件读写与命令行；`openfilm_*` / `openfilm_cli` 负责影片合成读取、分镜、抽帧、效果库、时间轴编辑与导出。
- **媒体供应商共用**：`no996` 配音及后续扩展的生图/生视频服务通过 `<sharedHome>/providers/no996/provider.mjs` 注册进 OpenFilm 媒体网关（`/api/get`），Agent 统一经由 `openfilm_get` 调用，与 DSH 对话模型零冲突。
