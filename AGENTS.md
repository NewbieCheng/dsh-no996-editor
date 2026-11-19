# AGENTS.md — no996-editor / No996 Studio

给在本仓工作的智能体的操作手册。**先读四篇**：[`README.md`](README.md)、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)、[`docs/STATE.md`](docs/STATE.md)；地图 [`docs/index.md`](docs/index.md)。

> 由 `openfilm-video-editing` 预设读入。细节写进 `docs/`，这里只留“不知道就会犯错”的部分。

## 0. 一句话

把官方 **OpenFilm 0.4.0** 工作台封装成可分发的 **DSH 插件**：Host 拉起 Studio 并反向代理，浏览器用 `shell.overlay` 常驻 iframe，右侧对话在 Host 进程内**直连 DSH 原生 `ctx.sessionController`**（绑定 `openfilm-video-editing` 预设，零 ACP 子进程）。当前 `0.17.11`。

## 1. 红线（违反即回退）

1. **不碰用户既有项目和会话。** 模板安装只新建目录；不迁移、不删除、不改写别人的 `film.html`。
2. **自动化测试禁止真实模型调用。** 只用 mock 与 `mkdtemp`。
3. **源码只推 GitHub `NewbieCheng/no996-editor`。** 插件只从 npmjs.org 安装/更新（包名 **`@newbiecheng/no996-editor`，必须小写**），手册 [`docs/playbooks/publish.md`](docs/playbooks/publish.md)；不要把 npmjs 当源码主仓，不要用本地 `.tgz` / `link:` 当用户通道。
4. **未验证不得声称完成。** 真机 GUI 里看到行为才算“好了”。
5. **不要把 `openfilm_draft` 当保存**（纯内存草稿）；**不要把 Studio 代理当安全边界**（本机回环集成，不是沙箱）。

### 1.1 装 / 更 / 发（最短清单）

开发、验证、提交、推送、发布到更新的 **AI 最短 SOP** 和完整步骤只认 [`docs/playbooks/publish.md`](docs/playbooks/publish.md)。源码只推 GitHub，npmjs.org 只作包 registry。

**当前阶段：本机调试。** 用户已授权把工作区构建装进本机 DSH 用于验证（装之前备份 profile 记录、装之后告知重启）；**发版不随开发自动串联**：改版本号、提交、推送、`npm publish`、tag/CI 发布都只在该用户当轮明确要求时执行。安装、更新、发版是三个独立动作，不能合并不说明。

**registry 必须保留 `dsh` 字段（2026-11-19 实证）：** DSH 的版本区靠 `pnpm view <包名>@<版本>` 的 `dsh.bundle` 判断能否安装。GitLab 与 GitHub Packages 都不保存 `dsh` 等自定义 manifest 字段，GUI 会显示「没有声明组合包，无法安装」；只有 npmjs.org 等标准 registry 保留完整 packument。因此发布通道固定为 npmjs.org。发布后跑 `node scripts/verify-registry-dsh.mjs` 确认 `dsh.bundle` 可被调用。

| 事 | 命令 / 动作 |
|---|---|
| 本机调试装 | 打包工作区 → `dsh plugin --profile desktop add <本地包>`（仅本机调试；先记下当前版本，验证完按需回滚） |
| 用户装 / 更 | `dsh plugin --profile desktop add @newbiecheng/no996-editor` / 版本选项卡 → 整应用重启 |
| 发 | 版本与说明、烘焙/构建产物就绪并提交 → `npm run release:check`（完整检查、registry 与构建打包验证；不发布）→ **用户当轮明确要求后**运行 `powershell -File .\scripts\npmjs-publish.ps1` → `npm view` + 真机「版本」区 |
| 包丢了 | `dsh plugin --profile desktop install`（勿在 Windows 手删 `@NewbieCheng`/`@newbiecheng` 目录） |

### 1.2 npmjs 发布铁律（2026-11-19 事故后固化，违反必翻 incident-history.md）

1. **发布通道只有 npmjs.org**。GitLab / GitHub Packages 不保存 `dsh` 字段，DSH GUI 版本区必定报「没有声明组合包，无法安装」；不要为了「按原渠道」再发回去。
2. **GUI 可更新的充要条件**：`pnpm view <包名>@<版本> dsh` 能读到 `dsh.bundle`。发布后用 `node scripts/verify-registry-dsh.mjs` 核对，别只看 `npm publish` 的退出码。
3. **token 只能进环境变量或系统临时文件**。绝不写 `.npmrc` 到仓库、绝不 `git add -A` 顺手提交。发布脚本用临时目录改写 manifest 的 `publishConfig.registry`，finally 删除临时 `.npmrc`。
4. **Bypass-2FA token 只用于发布**：它不能 unpublish / 删包（403）；删除要真人在 npmjs 网页过 2FA。发布前想清楚版本号，删错了只能换新包名或新版本号。
5. **同一 name@version 永久不可复用**，unpublish 也会留下 `0.0.0-stage` 占位并把 `latest` 指过去。撤销过的版本号必须换新号；发版前先 `npm view <包名>@<版本>` 确认 404。
6. **发布成功 ≠ 立即可见**：PUT 202 后 packument 可能几十分钟才更新。短暂 404 时等待并复查 `versions` 与单版本端点，**不要重发、不要换名、不要改代码**。
7. **品牌改名要同步 bundle id**：包名同时是 `cordis.patch.yml` 的 bundle 名与 `client.js` 的 ModuleLoader id/slot key。改包名后必须 `npm run build` 重建客户端、重建官方壳快照并重放补丁，否则插件无法激活。
8. **探针包也是包**：验证用探针包发布后必须清理；清理需要真人 2FA，所以在发探针前就想好谁删、什么时候删。


## 2. 四层界面，两级手段

四层（L0 我们的壳 / L1 官方桌面壳 / L2 Studio 编辑器 / L3 影片）按改动位置选择 token、CSS 或上游源码补丁；上游源码与构建方式见 [`docs/playbooks/upstream-bump.md`](docs/playbooks/upstream-bump.md)，注入边界见 [`docs/reference/injection-registry.md`](docs/reference/injection-registry.md)。不要假定 L2 只能注入 CSS。

### 2.1 对话边界与预设注入链

1. **页面的对话 id 必须一路到 Host。** 每个 agent RPC 都带 `conversation`；Host 内按 `(projectId, conversation)` 映射原生 DSH `sessionId`，存 `~/.dsh/no996-openfilm/native-sessions.json`（v2）。
2. **影片文件夹是指令链的根。** `cordis.patch.yml` 的 `preset-openfilm-video-editing` 配置 `agent-instructions.projectRootMarkers = [.git, .film, film.html]`（上层仓库的 `AGENTS.md` 不进影片对话）、`persona`（剪辑与动效搭档）、`openfilm-prompt` 与隔离的 `openfilm-skills`（`skill-filesystem.includeDefaultRoots = false`）。
3. **知识按需读，不进系统提示。** persona ≤ 400 B；手册走 `openfilm_guide`，风格/镜头卡走 `skill('openfilm-motion')`，模板走 `openfilm_library kind=template`。

**按任务选择工作流**：制作或重构影片时先了解素材和时间轴，再用 `.film/storyboard.json`（`openfilm_storyboard`：read/write/plan/from-script/subtitles）规划；口播需要转写时才用 `openfilm_transcribe`。纯问答、小修改或无语音素材不强制转写和完整分镜。

**项目 `AGENTS.md` 从不覆盖**，只有字节等于我们写过的版本才升级（sha256 白名单，`src/project/project-instructions.mjs`）。

### 2.2 新增模板时，它的提示词怎么注入

模板自带“设定与思路”：`vendor/templates/<id>/prompt.md`（≤ 2 KB），只进选了该模板的项目（`src/film/template-prompts.mjs`）：

```text
openfilm_library(kind=template, take=<id>)
  → <项目>/.film/templates.json   { "active": ["sketchnote", …] }
  → 仅可确认插件所有的 <项目>/AGENTS.md 才同步模板块
  → 当前轮从工具回执读取；后续会话读取成功同步的项目指令
```

- **加模板三件事**：建 `vendor/templates/<id>/`；`manifest.json`（必填 `id/title/entry/mode`）；`prompt.md`。完整步骤见 [`docs/TEMPLATES.md`](docs/TEMPLATES.md)。
- **不要**手改生成块、不要把模板提示词写进 persona/工具描述。

## 3. 仓库地图

| 目录 | 内容 |
|---|---|
| `src/host/` | 日志、偏好、elevation、download、trace、area-bus |
| `src/studio/` | controller(+routes)、proxy、runtime、debug、panel、entry |
| `src/native/` | 原生 DSH `SessionController` 驱动、会话存储、指令盘点、预设技能与提示词 |
| `src/official/` | facade / chat-rpc / events / permission / templates / shell |
| `src/auth/` | workbench-auth、auth-bridge、login-remember |
| `src/tools/` | `*-tool.mjs`、tool-installer |
| `src/film/` | storyboard、script-plan、draft、timeline、template-* |
| `src/asr/` | asr-*、transcribe-service |
| `src/project/` | project-instructions/files/trash、editing-*、archive |
| `src/ui/` | theme、brand、shell-extras、style-lab、sidebar-editing |

## 4. 最短路径与生效矩阵

- 日常先跑 `npm run check:quick`（变更代码语法 + 能自动识别的相关测试；动态依赖可能漏检，补跑相关测试）；**提交前必跑** `npm run check`（完整 lint + test + docs/brand/templates/patches）。改客户端源码需 `npm run build`；改 `_kit`/`shots` 需 `npm run templates:build`；改源码/路由需 `npm run docs:gen`。
- **生效方式**：改主题/CSS 刷新即生效；改 `src/studio/studio-entry.js` 等需 `npm run build` 后刷新；改 `index.js` / `src/**/*.mjs` 需重载插件并刷新；若模块缓存导致未生效，保存工作并按提示完整重启 DSH；改 `cordis.patch.yml` / `skills/**` 影响之后新建的会话。

## 5. 端口、证据与规范

- **端口**：编辑器代理 `:47822`、调试窗口 `:47821`（`0`=关）；桌面页面来源为 `dsh-app://app`。变量全表见 [`docs/reference/env-vars.md`](docs/reference/env-vars.md)。
- **证据入口**：出事先看 [`docs/playbooks/incident.md`](docs/playbooks/incident.md)。`POST /api/no996-openfilm/diagnose` 与 `%TEMP%\no996-editor\plugin.log`；进度只写在 [`docs/STATE.md`](docs/STATE.md)。
- **不要做**：不手改 `client.js`；不让 `openfilm_draft` 承担保存/导出；不声称未接通的预览/导出沙箱已接通；不在业务提示词里塞风格库/镜头卡/模板全文。
