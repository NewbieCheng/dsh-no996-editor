<!-- doc
id: injection-registry
reader: 改界面的人、reviewer
fact-source: assets/shell-ui.js、assets/shell-login.js、assets/theme/*.css、src/ui/sidebar-editing.mjs
checked: 0.16.1
rot-if: 新增/撤掉任何一处没走源码的改动
-->

# 注入登记表

> 每一处"没走源码"的改动都要在这里留一行。**没有登记 = 不允许合入。**
> 迁移顺序与判断口径（为什么源码优先、先迁哪几条）见 [ADR-0009](../decisions/ADR-0009-ui-change-strategy.md) §4。
> 登记只要三件事：为什么不能改源码、现在怎么工作、什么条件下撤掉。

## 1. 登记表

| 注入 | 文件 | 为什么不是源码 | 退出条件 |
|---|---|---|---|
| 视频工具环境检查卡 | `assets/shell-ui.js` | 需要 Host 能力，上游没有这个界面 | 上游有环境检查或迁进 A1 |
| Host 截走 drop 后清 pageDropping | `assets/shell-ui.js`（`clearPageDropping`） | 正式修法已在 `patches/010-App.patch` 并 bake 进壳；注入侧仍双保险 | 确认真机 Host drop 不再卡「松手即可附上」后，可删注入侧 `clearPageDropping` |
| 工作区下拉开关 | `src/ui/sidebar-editing.mjs` | 侧栏标题行没有官方插槽；`sidebar.workspaces` 是 single 槽 | DSH 开出标题行插槽后删除 |
| 音色库改写为不加班 | `studio-proxy` `rewriteLibraryVoices` | 不改 VoicesPane 源码，复用官方列表 UI | 上游 VoicesPane 原生支持 no996 后改补丁 |
## 1.0 隐藏的 OpenFilm 设置项与界面清单

以下为当前刻意隐藏或收拢的 OpenFilm / DSH 原生界面与设置项。OpenFilm 表面收敛改由可回放的上游源码补丁实现，DSH 侧栏仍是窄注入：

| 位置 | 隐藏 / 调整内容 | 实现方式 |
|---|---|---|
| 设置 → 服务商 | 只展示 OpenFilm、No996 和本地服务；不更改服务商数据或凭据 | `ProvidersSection.tsx` 源码补丁 |
| 顶部 / 工作模式切换 | 编辑态不提供画布入口；已在画布中时保留返回编辑器的按钮，不修改 localStorage | `shell/top-bar.tsx` 源码补丁（0.4.0 起顶栏在壳里） |
| 顶栏账号条 | 右侧显示 No996 账号（余额抽屉、登录态），与 0.4.0 新顶栏的其它按钮并排 | `shell/top-bar.tsx` 源码补丁 |
| 语音抽屉（Voices） | 隐藏服务商分组，默认展示精选音色；保留底层音色数据 | `LibraryDrawer.tsx` 源码补丁 |
| 顶栏菜单 | 隐藏社区与外链菜单项 | `AppMenu.tsx` 源码补丁 |
| 更新提示 | 不自动弹出上游更新说明；不写用户 `seenVersion` 偏好 | `WhatsNew.tsx` 源码补丁 |
| DSH 侧栏「工作区」 | 隐藏原生标题 `span` 替换为「工作区 / 剪辑区」两态开关；在「工作区」视图下隐藏剪辑专属文件夹（`Projects`/`OpenFilm`）与 `hiddenSessionIds` 会话行 | `src/ui/sidebar-editing.mjs` |

## 1.1 已经不在注入里的（别再加回来）

| 东西 | 现在在哪 |
|---|---|
| 项目 / 示例 / 模板入口 | `ProjectsLibrary.tsx` 与 `ExamplesGallery.tsx`（原生窗口的补丁）；独立模板选择门不再挂载 |
| 「更多技能 / 从示例开始」的点击屏蔽 | 删除：技能库与原生「我的项目 / 示例」窗口都已可用，`assets/shell-ui.js` 不再拦截这两个入口（`tests/shell-extras.test.mjs` 守） |
| 账号条 / 登录态 | `packages/openfilm/studio/ui/src/components/WorkbenchAccount.tsx`（React 源码，补丁） |
| 设置 About / 侧栏「兼容 OpenFilm」/ 语言说明 | `SettingsModal.tsx` + `studio/ui/src/i18n/*`（撤掉 `tuneAbout`） |
| L1/L2 工作台 Logo / UI 图标品牌替换 | **已删除**：不再用 `shell-ui.js` 扫 `header svg`；要换品牌改 `.upstream/openfilm` 源码补丁（ADR-0009 A1） |
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

针对上游 **OpenFilm 0.4.0** 的结构性改动直接以源码补丁维护于 `patches/`。精确文件、分组、顺序与哈希以 `patches/series.json` 为准；`npm run patches:check` 校验拆分结果，`npm run upstream:verify -- --dir <干净固定版本检出>` 校验可回放。项目窗口与表面收敛的新增改动用 `NO996-UPSTREAM` 注释标明。
