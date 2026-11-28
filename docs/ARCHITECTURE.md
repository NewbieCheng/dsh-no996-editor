<!-- doc
id: architecture
reader: 开发者、智能体
fact-source: index.js、cordis.patch.yml、src/native/dsh-native-agent-service.mjs、src/film/template-prompts.mjs
checked: 0.22.0
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
│ no996-editor（DSH Cordis 插件，运行在 DSH Host 进程内）       │
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
- **剪辑区与工作区共用一条会话**：新建会话只复用已有且目录匹配的 `workspaceId`，不为影片注册新工作区。绑定对话**不再从工作区列表隐藏**：工作区行与剪辑区行是同一条 DSH 会话的两扇门，两边天然一致，无需复制会话来找历史（早期版本曾隐藏这些行，导致用户复制会话反而分叉历史，0.21.12 起移除）。切换区域不改变归档状态。
- **不抛误导性 503**：429 限流、冷却期等模型/回合业务错误仅通过 SSE `done: { ok: false, error }` 在聊天框内提示，不再触发底部全局 HTTP 503 红条。

### 2.2 预设联动、指令链与模板发现
1. **预设与 Skill 隔离**（[cordis.patch.yml](../cordis.patch.yml)）：
   - `preset-openfilm-video-editing` 内置 `@deepseek-ai/dsh-persona`（剪辑与动效搭档人设）、`@newbiecheng/dsh-no996-editor/openfilm-prompt`、`@newbiecheng/dsh-no996-editor/openfilm-skills`（注册包内 [`skills/`](../skills/) 下的技能，包括导演、剪辑、动效、Vibe Craft），并设 `skill-filesystem.includeDefaultRoots: false`，不继承 DSH 全局技能根。
   - `agent-instructions` 配置 `projectRootMarkers: ['.git', '.film', 'film.html']`，保证影片文件夹自身就是指令根，仓库/单仓上层的 `AGENTS.md` 不进入影片对话。
2. **模板是可选资源**（[目录](../src/film/template-catalog.mjs)）：搜索只读清单，按比例、用途和槽位缩小范围，最多返回 5 项。用户点名时才按 ID 读说明；外部包仅作为参考数据。模板创建和本片参考记录只写 `.film/templates.json`，不再给项目指令添加或刷新模板块。既有文件不迁移。

### 2.3 聊天桥、实时模式和显式技能

- **请求链**：OpenFilm 聊天组件 → [iframe facade](../src/official/official-facade.mjs) → [Studio Host RPC](../src/studio/studio-controller.mjs) → [原生 Agent 驱动](../src/native/dsh-native-agent-service.mjs) → DSH `sessionController`。浏览器路径/会话 ID 不是授权依据；Host 验证项目并根据 `(projectId, conversation)` 绑定会话。流式状态经 SSE 返回。
- **模式与模型**：发送前确保当前剪辑 Agent 已注册一个必需的 `systemPrompt.context`；每次装配/刷新读取本会话的模式、实际阶段和自动导出，不拼到用户正文。当前模型留在菜单和请求元数据，不重复注入。项目指令、运行环境、技能目录仍由 DSH 分别提供，剪辑界面不把它们渲染成用户消息，工作模式继续用一个控件。手动模式优先；切回 Auto 清理旧阶段，模型根据新请求调用 `no996_mode` 更新阶段，Host 发 `mode_update` 刷新界面。这不是输入框层面的自动分类器。与 DSH `/plan` 一样，已发出的模型请求不被倒改；`/plan` 在轮中把选择排到下一个接受的步骤，剪辑模式则即时保存选择并在下一次提示装配/刷新时读取，不调用 `/plan`、不改变沙箱权限。切模型时以会话确认的模型和档位为准，「默认」不提交自造档位。
- **两路技能**：[技能目录](../src/native/film-skill-selection.mjs) 合并剪辑预设同源内置技能与 OpenFilm 已启用的个人/项目技能。`skills:list` 不开模型回合，不读 DSH 全局目录。选中只添加引用，发送携带来源区分的 ID，Host 重新校验并将所选内容放入当前回合的独立上下文。这里是上下文桥，不是 DSH 原生 slash command，也不负责安装、不授予额外权限。
- **已知边界**：预设组目前是内置注册同源目录，不是实际 Agent 的 `skills.snapshot`，因此不能宣称覆盖预设的运行时增删或所有调用限制。OpenFilm 安装仍走上游入口；嵌入面板只发现和引用已安装技能。

### 2.4 流式、工具展示、上下文占用与自动压缩
- **流式与思考收口**：`follow({ assistantStream: true })` 实时下发 `text-delta` / `reasoning-delta`（`end` 帧带 `seal: true` 防重复拼接），并在 `assistant/message` 下发权威 `agent_message_chunk`，由前端 `claimAttempt` 接管并将「正在思考」收口为「思考了 Xs」。
- **全量工具行**：`mapToolCallForUi` 将 DSH 原生工具（`pwsh` / `bash` / `read` / `glob` / `grep` / `write` / `edit` / `web_search` / `web_fetch` / `skill`）与 `openfilm_*` / `openfilm_cli` 统一映射到持久化的 `ActRow`，并透传精简 `rawOutput`。
- **上下文占用与自动压缩**：
  - 从 `follow()` 初始 `snapshot.projections` 及每轮 `sessionController.projections({ sessionId })` 读取 `contextPressure`（`contextWindow`、`projectedTokens ?? pressureTokens`），实时推送 `usage_update` 驱动底部 `ContextUsage` 圆环与 85% 预警高亮；
  - 监听 DSH 宿主自动压缩事件 `compaction/start` → `compaction/end`，向面板展示压缩活动行并在压缩完成后刷新占用百分比。

### 2.5 DSH 工具、可复用创作包与 OpenFilm 媒体能力共存
- **工具分工**：DSH 原生工具负责联网检索（`web_search`/`web_fetch`，依赖宿主 `ctx.web` 提供商如 `web-search-deepseek`）、通用文件读写与命令行；`no996_*` 负责影片合成读取、分镜、抽帧、效果库、时间轴编辑与导出，`no996_cli` 只保留不会另开 Studio 的只读动词。
- **创作包**：`packages/no996-scene-kit` 提供 DOM/SVG 场景、字幕、安全区和影片页组装；`packages/no996-motion-runtime` 提供只依赖时间 `t` 的确定性动作。两者是源码依赖，不是独立运行时服务。
- **本地配方**：项目标题菜单的「另存为本地模板」通过 `template:recipe-*` / `template:local-*` RPC 读取已保存影片，只提取选中页面和直接本地资源，保存为 `recipe.json` + 内容寻址素材。配方导入不执行 HTML/JS；市场索引只作为数据，安装校验 SHA-256。
- **媒体供应商共用**：`no996` 配音及后续扩展的生图/生视频服务通过 `<sharedHome>/providers/no996/provider.mjs` 注册进 OpenFilm 媒体网关（`/api/get`），Agent 统一经由 `openfilm_get` 调用，与 DSH 对话模型零冲突。
