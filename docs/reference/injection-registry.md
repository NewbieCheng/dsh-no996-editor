<!-- doc
id: injection-registry
reader: 改界面的人、reviewer
fact-source: assets/shell-ui.js、assets/shell-login.js、assets/theme/*.css、src/ui/sidebar-editing.mjs
checked: 0.15.26
rot-if: 新增/撤掉任何一处没走源码的改动
-->

# 注入登记表

> 每一处"没走源码"的改动都要在这里留一行。**没有登记 = 不允许合入。**
> 迁移顺序与判断口径（为什么源码优先、先迁哪几条）见 [ADR-0009](../decisions/ADR-0009-ui-change-strategy.md) §4。
> 登记只要三件事：为什么不能改源码、现在怎么工作、什么条件下撤掉。

## 1. 登记表

| 注入 | 文件 | 为什么不是源码 | 退出条件 |
|---|---|---|---|
| 模板选择弹窗 | `assets/shell-ui.js` | 历史上先做的注入；上游有模板入口 | 模板主路径迁进 A1 后删除 |
| 视频工具环境检查卡 | `assets/shell-ui.js` | 需要 Host 能力，上游没有这个界面 | 上游有环境检查或迁进 A1 |
| Host 截走 drop 后清 pageDropping | `assets/shell-ui.js`（`clearPageDropping`） | 正式修法已在 `patches/010-App.patch` 并 bake 进壳；注入侧仍双保险 | 确认真机 Host drop 不再卡「松手即可附上」后，可删注入侧 `clearPageDropping` |
| 工作区下拉开关 | `src/ui/sidebar-editing.mjs` | 侧栏标题行没有官方插槽；`sidebar.workspaces` 是 single 槽 | DSH 开出标题行插槽后删除 |
| 表面收敛（藏服务商/画布/多余菜单） | `assets/theme/studio.css` + `src/studio/studio-proxy.mjs`（`__no996SurfaceHide`） | L2 为 dist；本轮要可逆隐藏而非删供应商 | 产品恢复第三方配音 / 画布后删规则与脚本 |
| 音色库改写为不加班 | `studio-proxy` `rewriteLibraryVoices` | 不改 VoicesPane 源码，复用官方列表 UI | 上游 VoicesPane 原生支持 no996 后改补丁 |

## 1.0 隐藏的 OpenFilm 设置项与界面清单

以下为当前刻意隐藏或收拢的 OpenFilm / DSH 原生界面与设置项，全部通过可逆注入实现：

| 位置 | 隐藏 / 调整内容 | 实现方式 |
|---|---|---|
| 设置 → 服务商（Providers） | 隐藏第三方服务商卡片与 chip（`ElevenLabs`、`Inworld`、`Cartesia`、`OpenAI`、`Google`、`Microsoft Azure`、`OpenRouter`、`fal.ai`、`Groq`、`Pexels`、`Pixabay`、`Brave Search`、`Tavily`、`Keenable`、`Doubao`、`Mimo`），仅保留 `OpenFilm`、`不加班`、`no996`、`本地服务` | `src/studio/studio-proxy.mjs`（`__no996SurfaceHide`） |
| 设置 → 服务商展开按钮 | 隐藏「还有 N 个 / 收起」展开按钮（`[data-settings-card='providers'] button[aria-expanded]`） | `assets/theme/studio.css` |
| 顶部 / 工作模式切换 | 隐藏画布模式开关（`[data-work-mode]`），并将 `localStorage` 中 `openfilm.canvas.open:*` 强制锁定为 `'0'` | `assets/theme/studio.css` + `studio-proxy.mjs` |
| 语音抽屉（Voices） | 隐藏「服务商 / Services」折叠分组（`nav[data-studio-host-panel]`） | `studio-proxy.mjs`（`__no996SurfaceHide`） |
| 顶栏菜单 | 隐藏社区菜单（`[data-community-menu]`）与多余应用菜单项（`[data-app-menu]`） | `assets/theme/studio.css` |
| DSH 侧栏「工作区」 | 隐藏原生标题 `span` 替换为「工作区 / 剪辑区」两态开关；在「工作区」视图下隐藏剪辑专属文件夹（`Projects`/`OpenFilm`）与 `hiddenSessionIds` 会话行 | `src/ui/sidebar-editing.mjs` |

## 1.1 已经不在注入里的（别再加回来）

| 东西 | 现在在哪 |
|---|---|
| 账号条 / 登录态 | `packages/openfilm/studio/ui/src/components/WorkbenchAccount.tsx`（React 源码，补丁） |
| 设置 About / 侧栏「兼容 OpenFilm」/ 语言说明 | `SettingsModal.tsx` + `studio/ui/src/i18n/*`（撤掉 `tuneAbout`；先前误以为它导致空壳已回退，根因实为品牌 MutationObserver） |
| 故障恢复（静默自愈，无卡片） | `apps/desktop/shell/RecoveryGate.tsx`（探活 + `no996-openfilm:restart`；面板侧退避重拉；2026-11 去掉阻塞卡） |
| 主题 token + 覆盖 | 发布产物在构建期由 `npm run shell:bake` 烘进 `vendor/official-shell/ui/assets/no996-theme.css`；运行时那份只是开发热更 |
| 全屏登录门 | `apps/desktop/shell/LoginGate.tsx`（React，样式 `login.css`）；听 `no996-auth-changed` 以便退出后重新显示；`assets/shell-login.js` 只作迁移期的参考实现 |
| 城市背景 | 生成物 `assets/login-city.js`，构建期由 `npm run login:sync` 复制进上游壳，`import` 后挂 `window.__NOF_MOUNT_CITY__` |
| 视频工具环境检查卡 | 仍是注入，见上表 |

## 2. 侧栏那一处为什么是"窄注入"

`sidebar.workspaces` 是 **single** 槽：一个优先级一个注册，最小者独占渲染，且官方浏览器组件未导出。占用它等于重写整块界面——置顶、归档、运行中、右键菜单、拖拽都会丢，2026-11 真机试过并撤回（见 ADR-0006）。

现行做法（`src/ui/sidebar-editing.mjs`）：

1. 文本 + 结构锚点找到「工作区/会话」`span`，**只隐藏它并插入切换按钮**；
2. 选「剪辑区」时隐藏它的兄弟列表、显示我们的列表，头部只留搜索（视图选项移进文件夹行的 ⋯）；
3. 按钮占 header 固定槽（`data-no996-switch-host` + `--n996-switch-w`），搜索展开永远在剩余宽度里；
4. 删除项目走 `POST /api/no996-openfilm/editing-delete-project`，前端不直接删文件。

**不占 single 槽、不加行级按钮、不往会话菜单/视图菜单加条目。**

回归保护：`tests/sidebar-untouched.test.mjs` 在源码里出现 `sidebar.workspaces` 注册、`viewOptionsMenu`、`data-row-key`、`contextMenus` 等字样时失败，并单独断言这处开关只碰标题、不碰列表行。

## 3. 注入层的硬约束

- 不承载权限、凭据、业务写操作；只做展示与转发到既有 RPC；
- 所有节点带 `data-no996-*` 标记，一次性可摘除；
- 样式注入失败必须整块跳过，不能把应用弄白；
- 关断开关：`NO996_OPENFILM_THEME=0`（样式）、侧栏开关的源码级开关（注入逻辑本身）。

## 4. 撤销一处注入时

1. 删代码 + 删登记行 + 更新对应测试；
2. 在 `CHANGELOG.md` 记一行"撤销某注入"；
3. 如果它曾是某个 bug 的临时修法，去 `playbooks/incident.md` 补一句"根因已消除"。

## 5. 上游源码补丁总览（`patches/series.json`）

除运行时注入与 CSS 隐藏外，针对上游 **OpenFilm 0.3.2** 的结构性改动直接以源码补丁维护于 `patches/`（共 39 个补丁，`npm run patches:check` 校验 sha256 与顺序）：

| 分组 | 数量 | 覆盖范围与典型补丁 |
|---|---|---|
| `chat` | 28 | 对话主流程、消息流与工具活动行（`010-App`、`020-AgentActivityRow`、`030-ContextUsage`、`040-ConversationSessionBar`、`050-Markdown`、`090-TemplatePicker`、`150-agent-activity-runs`、`170-agent-transcript`、`180-chat-store`、`190-desktop-attachments`、`200-local-agent-run`、`210-local-agent-store`、`220-EnvironmentNotice`、`230-LoginGate`、`240-RecoveryGate`、`250-brand-mark`、`260-login-city`、`270-login.css`、`280-main`、`290-ProjectView`、`300-WorkbenchAccount`、`310-ModelsSection`、`320-SettingsModal`、`330-en`~`370-zh-CN`） |
| `i18n` | 5 | `apps/desktop/chat/src/i18n/locales/*` 五语言词条补丁（`100-en-US`、`110-es`、`120-ja`、`130-ko`、`140-zh-CN`） |
| `menus` | 2 | 模型与智能体菜单行（`060-ModelPopover`、`160-agent-menu-rows`） |
| `onboarding` | 2 | 引导门与项目起步卡片（`070-OnboardingGate`、`080-ProjectStarters`） |
| `shared` | 2 | 契约与 Markdown 块解析（`380-contract`、`390-markdown-blocks`） |
