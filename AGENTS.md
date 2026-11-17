# AGENTS.md — dsh-openfilm / No996 Studio

给在本仓工作的智能体的操作手册。**先读四篇**：[`README.md`](README.md)、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)、[`docs/STATE.md`](docs/STATE.md)；地图 [`docs/index.md`](docs/index.md)。

> 由 `openfilm-video-editing` 预设读入。细节写进 `docs/`，这里只留“不知道就会犯错”的部分。

## 0. 一句话

把官方 **OpenFilm 0.3.2** 工作台封装成可分发的 **DSH 插件**：Host 拉起 Studio 并反向代理，浏览器用 `shell.overlay` 常驻 iframe，右侧对话在 Host 进程内**直连 DSH 原生 `ctx.sessionController`**（绑定 `openfilm-video-editing` 预设，零 ACP 子进程）。当前 `0.15.26`。

## 1. 红线（违反即回退）

1. **不碰用户既有项目和会话。** 模板安装只新建目录；不迁移、不删除、不改写别人的 `film.html`。
2. **自动化测试禁止真实模型调用。** 只用 mock 与 `mkdtemp`。
3. **只推 `NewbieCheng/dsh-openfilm`。**
4. **未验证不得声称完成。** 真机 GUI 里看到行为才算“好了”。
5. **不要把 `openfilm_draft` 当保存**（纯内存草稿）；**不要把 Studio 代理当安全边界**（本机回环集成，不是沙箱）。

## 2. 四层界面，两级手段

四层（L0 我们的壳 / L1 官方桌面壳 / L2 Studio 编辑器 / L3 影片）优先 **token → CSS → 源码补丁**。见 ，判断流程与反模式见 。L2 只有 dist，只能 CSS 注入。

### 2.1 对话边界与预设注入链

1. **页面的对话 id 必须一路到 Host。** 每个 agent RPC 都带 `conversation`；Host 内按 `(projectId, conversation)` 映射原生 DSH `sessionId`，存 `~/.dsh/no996-openfilm/native-sessions.json`（v2）。
2. **影片文件夹是指令链的根。** `cordis.patch.yml` 的 `preset-openfilm-video-editing` 配置 `agent-instructions.projectRootMarkers = [.git, .film, film.html]`（上层仓库的 `AGENTS.md` 不进影片对话）、`persona`（剪辑导演）、`openfilm-prompt` 与隔离的 `openfilm-skills`（`skill-filesystem.includeDefaultRoots = false`）。
3. **知识按需读，不进系统提示。** persona ≤ 400 B；手册走 `openfilm_guide`，风格/镜头卡走 `skill('openfilm-motion')`，模板走 `openfilm_library kind=template`。

**剪辑的契约是分镜**：`.film/storyboard.json`（`openfilm_storyboard`：read/write/plan/from-script/subtitles）。先有分镜再动时间轴；丢视频先 `openfilm_transcribe` 再 `from-script` 按句切镜。

**项目 `AGENTS.md` 从不覆盖**，只有字节等于我们写过的版本才升级（sha256 白名单，`src/project/project-instructions.mjs`）。

### 2.2 新增模板时，它的提示词怎么注入

模板自带“设定与思路”：`vendor/templates/<id>/prompt.md`（≤ 2 KB），只进选了该模板的项目（`src/film/template-prompts.mjs`）：

```text
openfilm_library(kind=template, take=<id>)
  → <项目>/.film/templates.json   { "active": ["sketchnote", …] }
  → <项目>/AGENTS.md 的生成块      <!-- no996-openfilm:templates:begin --> … <!-- …:end -->
  → 原生 DSH 会话自动读取影片目录下的 AGENTS.md
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

- **提交前唯一必跑**：`npm run check`（lint + test + docs/brand/templates/patches）。改客户端源码需 `npm run build`；改 `_kit`/`shots` 需 `npm run templates:build`；改源码/路由需 `npm run docs:gen`。
- **生效方式**：改主题/CSS 刷新即生效；改 `src/studio/studio-entry.js` 等需 `npm run build` 后刷新；改 `index.js` / `src/**/*.mjs` 需重载插件并刷新（`touch index.js src/**/*.mjs` 确保 loader 重求值）；改 `cordis.patch.yml` / `skills/**` 影响之后新建的会话。

## 5. 端口、证据与规范

- **端口**：编辑器代理 `:47822`、调试窗口 `:47821`（`0`=关）；桌面页面来源为 `dsh-app://app`。变量全表见 [`docs/reference/env-vars.md`](docs/reference/env-vars.md)。
- **证据入口**：出事先看 [`docs/playbooks/incident.md`](docs/playbooks/incident.md)。`POST /api/no996-openfilm/diagnose` 与 `%TEMP%\dsh-openfilm\plugin.log`；进度只写在 [`docs/STATE.md`](docs/STATE.md)。
- **不要做**：不手改 `client.js`；不让 `openfilm_draft` 承担保存/导出；不声称未接通的预览/导出沙箱已接通；不在业务提示词里塞风格库/镜头卡/模板全文。
