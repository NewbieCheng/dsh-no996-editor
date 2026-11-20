# AGENTS.md — No996 Studio 仓库协作手册

进入本仓先读：[README](README.md)、[架构](docs/ARCHITECTURE.md)、[开发](docs/DEVELOPMENT.md)、[状态](docs/STATE.md)。查找专题用[文档索引](docs/index.md)。本文件是仓库开发规则，不是用户影片项目的预设提示词。

## 红线

- 不迁移、删除或改写用户既有项目与会话。用临时项目和 mock 测试，自动化不调用真实模型。
- 区分「源码已改」「构建通过」「本机已加载且真机已验」「正式已发布」。本地链接、版本号相同或构建通过都不是上线证据。
- 源码只推 GitHub `NewbieCheng/dsh-no996-editor` 的 `main`；正式用户只从 npmjs.org 安装小写包名 `@newbiecheng/dsh-no996-editor`，不可用 `link:` 或本地包替代正式渠道。改版本、提交、推送和发布只在用户当轮明确要求后执行。装前备份本机 profile，装后告知重启；细则只认[发布手册](docs/playbooks/publish.md)。
- 不手改构建产物，不改 DSH 本体，不用运行时 DOM/CSS 掩盖状态和数据问题。Studio 代理不是沙箱；`no996_draft` 只产内存草稿，不是保存或导出。

## 改哪一层

| 改动 | 入口与生效方式 |
|---|---|
| DSH 插槽、侧栏、iframe 外壳 | `src/studio/studio-entry.js` 等 → `npm run build` → 重载/刷新 |
| OpenFilm 聊天、活动行、模型/技能菜单 | 固定版 OpenFilm 源码 → [上游补丁与快照流程](docs/playbooks/upstream-bump.md) → 重载/刷新；别手改 `vendor/official-shell/ui` |
| 对话 RPC、预设、原生会话及工具 | `src/official/`、`src/native/`、`src/studio/`、`src/tools/`；Host 重载，遇模块缓存完整重启 DSH |
| 影片及模板 | `src/film/`、`vendor/templates/`；[模板手册](docs/TEMPLATES.md)；改 `_kit`/`shots` 后跑 `npm run templates:build` |

## 聊天与预设约束

- 每个 agent RPC 按 `(projectId, conversation)` 路由，Host 映射原生 `sessionId`，不要用「最近会话」兜底。同一 iframe 的历史、状态、模型、工具调用按对话和回合关联。
- 用户正文、DSH 运行时上下文和 UI 引用是三样东西。模式/阶段、当前模型及显式选中的技能走当前剪辑 Agent 的独立上下文，不拼用户气泡。手动模式优先；Auto 的实际阶段由 `no996_mode` 转换，不能只改按钮文案。
- `/` 技能分「DSH · 剪辑预设」和「OpenFilm · 已安装」。前者仅由剪辑预设同源内置目录供给，不读 DSH 全局技能；后者尊重 OpenFilm 安装、启用和项目范围。选中只加引用；发送时 Host 复核，两路 ID 不混。技能本身不授予新权限。
- 影片根是指令链根：`projectRootMarkers = [.git, .film, film.html]`、`includeDefaultRoots = false`。已有项目 `AGENTS.md` 不覆盖，只可升级哈希确认属于插件的旧稿。知识按需读，不把手册、风格卡和模板全文塞进 persona。制作/重构先了解素材，必要时转写并用 `openfilm_storyboard` 规划；问答和小改不强制走完整流程。
- 可靠终态必须来自 Host；思考 `seal`、工具结果、回合 `done` 是不同层级。历史兼容只读处理，不自动重发或重写历史。模型与档位以实际 provider 目录和应用结果为准，「默认」不是额外推理等级。

## 开发验收

- 开发先跑 `npm run check:quick` 并补相关测试；提交前 `npm run check`。路由或源码目录有变就跑 `npm run docs:gen`；上游壳要核对 `patches:check`、干净固定版重放和 manifest。
- 本机可使用工作区链接开发，正式包仍走 registry。重启后核对实际 Host 和壳；涉及界面须在原桌面 GUI 用临时项目验收。失败先查[故障手册](docs/playbooks/incident.md)；进度只写[状态页](docs/STATE.md)，架构只记当前源码契约。
