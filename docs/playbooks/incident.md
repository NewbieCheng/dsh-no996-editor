<!-- doc
id: playbooks-incident
reader: 排查故障的人、智能体
fact-source: src/native/dsh-native-agent-service.mjs、src/studio/studio-controller.mjs、docs/ARCHITECTURE.md
checked: 0.16.1
rot-if: 会话实现、诊断入口、重载方式或信任边界变化
-->

# 当前排障手册

先记录现象与证据，再下结论。旧故障和当时的处理保存在 [历史故障档案](incident-history.md)，其中 ACP 子进程、旧事件名及操作不能直接套用到当前原生会话实现。

## 最短流程

1. **保存用户工作**，记录 DSH、插件版本、当前 profile 和复现步骤；不删除或修改影片、会话及用户数据。
2. **确认请求到达哪一层**：核对页面 origin、实际请求 URL 与状态码；不要把 `dsh-app://` 的相对路径 404 自动归因为 Studio 离线。
3. 查看 `%TEMP%/dsh-no996-editor/plugin.log` 和 `POST /api/no996-openfilm/diagnose` 的可用诊断；对话问题结合 `native-session`、`native-prompt-start`、`native-prompt-failed` 等实际日志与具体请求定位。日志、截图对外分享前去除凭据和隐私。
4. 对照 [架构](../ARCHITECTURE.md)、[开发生效矩阵](../DEVELOPMENT.md) 和当前源码；测试或日志只能证明观察到的范围，不代替 GUI 验收。
5. 确需重载时先告知并保存未保存编辑；如果管理器返回 `restart-required`，完整重启 DSH。Host 重建日志不证明 GUI 已应用，须在原页面核验。

## 常见症状与入口

| 症状 | 先核实什么 | 后续 |
|---|---|---|
| 看不到插件或版本区 | profile、registry 包名、安装来源与重启提示 | [安装 / 更新手册](publish.md) |
| 面板白屏或启动超时 | 页面 origin、bootstrap 请求、Host 日志和 Studio 健康情况 | [开发文档](../DEVELOPMENT.md)；历史案例仅用于提出假设 |
| 剪辑／放映／画布报 `Failed to fetch dynamically imported module` | 查看浏览器 Network：内置工作台模块应从独立的本地插件页面代理加载，不应直连 Studio 的内部模块端口 | 查 `plugin-surface-http` 的 HTTP 状态与 `s`（模块）或 `f`（项目文件）类别；诊断不记录授权 URL。HTTP 200 但缺少编辑器对应的 `Access-Control-Allow-Origin` 也会加载失败，不能只测端口。 |
| 对话无响应或模型不符 | 会话 ID、模型选择、原生会话日志和诊断事件 | [架构](../ARCHITECTURE.md)；不要以旧 `acp-*` 日志缺失判错 |
| 上下文圆环 0% 或 12 点小黑点 | `native-attach` 的 `usage`、`projections().contextPressure / contextBreakdown`、`ContextUsage.tsx` 是否已重编 | [架构](../ARCHITECTURE.md)；0% 不应渲染 `round` 进度弧 |
| 思考强度需发消息才同步 | `native-select-thinking` 日志、`attach` 是否同步 `agentPrefs`、空白会话 `store.setSelection` | [架构](../ARCHITECTURE.md)；核对 `official-facade.mjs` 的 `conversationId` |
| Windows 拖放被禁止 | DSH 与资源管理器是否以不同完整性级别运行、事件是否到达目标页面 | [历史拖放案例](incident-history.md)；不要仅凭管理员状态断言根因 |
| 打开项目时 Host 进程直接退出（无 JS 报错） | 项目路径是否含 8.3 短名（如 `ADMINI~1`）；崩溃是否在 `fs-event.c` | 上游 Studio 用 `fs.watch(..., { recursive: true })` 监听项目文件夹，libuv 在短名/长名混用时断言失败。把测试项目放在普通路径（如仓库 `.dev/`）即可复现/规避；真实项目默认在 `~/Videos/OpenFilm/Projects`，不受影响。 |
| 本地 `file:` 安装后工作台 503、日志 `STUDIO_START` | 先跑 `node scripts/installed-studio-probe.mjs`（按 Host 的方式从 profile 加载 Studio） | pnpm 对 `file:` 包装会按 `package.json` 重装依赖并清掉未声明的 `node_modules`；`openfilm` 所需的 `playwright-core` 必须在本包 `dependencies` 里声明。`scripts/pack-tgz.mjs` 同时把每个 bundled 包的依赖树嵌进它自己的 `node_modules`。修完重装并重启。 |
| 改动未生效 | 实际安装来源、是否构建、插件是否重载、原 GUI 是否刷新 | [生效矩阵](../DEVELOPMENT.md) |

新增故障记录写明：现象、可复核证据、根因、改法和未验证边界；设计取舍写入 ADR，进度写入 [STATE](../STATE.md)。
