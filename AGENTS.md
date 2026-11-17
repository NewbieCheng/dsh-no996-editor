# AGENTS.md — dsh-openfilm / No996 Studio

给在本仓工作的智能体的操作手册。**先读四篇**：[`README.md`](README.md)、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)、[`docs/STATE.md`](docs/STATE.md)；地图 [`docs/index.md`](docs/index.md)。

> 由 `openfilm-video-editing` 预设读入。细节写进 `docs/`，这里只留"不知道就会犯错"的部分。

## 0. 一句话

把官方 **OpenFilm 0.3.2** 工作台封装成可分发的 **DSH 插件**：Host 拉起 Studio 并反向代理，浏览器用 `shell.overlay` 常驻 iframe，官方对话交给 `dsh --profile acp` 子进程。**一个项目一个子进程，一条对话一条 ACP 会话。** 当前 `0.15.22`。

## 1. 红线（违反即回退）

1. **不碰用户既有项目和会话。** 模板安装只新建目录；不迁移、不删除、不改写别人的 `film.html`。
2. **自动化测试禁止真实模型调用。** 只用 mock 与 `mkdtemp`。
3. **只推 `NewbieCheng/dsh-openfilm`。**
4. **未验证不得声称完成。** 真机 GUI 里看到行为才算"好了"。
5. **不要把 `openfilm_draft` 当保存**（纯内存草稿）；**不要把 Studio 代理当安全边界**（本机回环集成，不是沙箱）。

## 2. 四层界面，两级手段

四层（L0 我们的壳 / L1 官方桌面壳 / L2 Studio 编辑器 / L3 影片）与手段顺序 **token → A2/B1 → A1 → B2** 见 [`docs/reference/ui-layers.md`](docs/reference/ui-layers.md)，判断流程与反模式见 [`docs/playbooks/ui-change.md`](docs/playbooks/ui-change.md)。L2 只有 dist，只能 CSS 注入。

### 2.1 对话边界与注入链（改对话行为前必读，见 [ADR-0011](docs/decisions/ADR-0011-director-contract.md)）

1. **页面的对话 id 必须一路到 Host。** 每个 agent RPC 都要带 `conversation`；子进程内按对话 `session/new` / `session/resume`，id 存 `~/.dsh/no996-openfilm/acp-sessions.json`（v2，v1 读成默认对话）。漏掉就是"新建对话接着上一轮聊"。
2. **影片文件夹是指令链的根。** `cordis.patch.yml` 的 `preset-openfilm-video-editing` 覆盖 `agent-instructions.projectRootMarkers = [.git, .film, film.html]`（仓库/单仓上层的 `AGENTS.md` 因此不进影片对话）和 `persona`（"剪辑导演"），定义见 `src/native/openfilm-persona.mjs`。改注入链前看 `/diagnose.instructions`：persona、逐文件字节、`outside`、`budget ≤ 6 KB`。
3. **知识按需读，不进系统提示。** persona ≤ 400 B；手册走 `openfilm_guide`，风格/镜头卡走 `skill('openfilm-motion')`，模板走 `openfilm_library kind=template`。往系统提示里塞风格库/镜头卡/模板全文是返工的开始。

**剪辑的契约是分镜**：`.film/storyboard.json`（`openfilm_storyboard`：read/write/plan/from-script/subtitles）。先有分镜再动时间轴；丢视频先 `openfilm_transcribe` 再 `from-script` 按句切镜。`openfilm_clip` 加不了片段，`plan` 的 `missing` 就是这条路的出口——不要假装能加。

**项目 `AGENTS.md` 从不覆盖**，只有字节等于我们写过的版本才升级（sha256 白名单，`src/project/project-instructions.mjs`）。

### 2.2 新增模板时，它的提示词怎么注入

模板自带"设定与思路"：`vendor/templates/<id>/prompt.md`（≤ 2 KB）。只进**选了这个模板的那个项目**，不进别人的系统提示。链路全自动（`src/film/template-prompts.mjs`）：

```
openfilm_library(kind=template, take=<id>)
  → <项目>/.film/templates.json   { "active": ["sketchnote", …] }
  → <项目>/AGENTS.md 的生成块      <!-- no996-openfilm:templates:begin --> … <!-- …:end -->
  → 子进程本来就读 AGENTS.md（影片文件夹是指令链的根）→ 下一轮/下次会话都还在
```

- **加模板三件事**：建 `vendor/templates/<id>/`；`manifest.json`（必填 `id/title/entry/mode`，建议 `description/tags`）；`prompt.md`（给谁看、什么调子、镜头怎么走、屏上字规矩）。无注册表，扫目录即发现。
- **可叠多个**：`active` 顺序即渲染顺序；单 prompt 截 2048 字符、整块 8 KB；取消 = 从 `active` 删掉。
- **当轮靠工具结果**（DSH 靠文件操作刷新指令，不监听外部写文件），**以后各轮靠文件**。
- **不要**手改生成块、不要把模板提示词写进 persona/工具描述、不要把安装步骤写进 `prompt.md`（那是 [`docs/TEMPLATES.md`](docs/TEMPLATES.md)，加模板的完整步骤也在那）。

## 3. 仓库地图

`src/` 按故障域分目录（根下只有这些文件夹，不再平铺 `.mjs`）：

| 目录 | 内容 |
|---|---|
| `src/host/` | 日志、偏好、elevation、download、trace、area-bus |
| `src/studio/` | controller(+routes)、proxy、runtime、debug、panel、entry |
| `src/native/` | 原生 DSH SessionController 驱动、会话存储、指令盘点、预设技能与提示词 |
| `src/official/` | facade / chat-rpc / events / permission / templates / shell |
| `src/auth/` | workbench-auth、auth-bridge、login-remember |
| `src/tools/` | `*-tool.mjs`、mcp-server、tool-installer |
| `src/film/` | storyboard、script-plan、draft、timeline、template-* |
| `src/asr/` | asr-*、transcribe-service |
| `src/project/` | project-instructions/files/trash、editing-*、archive |
| `src/ui/` | theme、brand、shell-extras、style-lab、sidebar-editing |

入口：`index.js`、`cordis.patch.yml`。技能/模板/动效：`skills/**`、`vendor/templates/**`、`vendor/motion/**`、`assets/**`、`brand/brand.json`。上游快照：`vendor/official-shell/**` + `patches/`。客户端：`src/studio/studio-entry.js` → `client.js`（禁止手改）。逐模块见 [`docs/reference/modules.md`](docs/reference/modules.md)。

## 4. 最短路径

`npm run check` 是提交前唯一必须跑的（lint + test + docs/brand/templates/patches）。改了客户端源码要 `npm run build`；改了 `_kit`/`shots` 要 `npm run templates:build`；改了源码/路由要 `npm run docs:gen`（reference 是生成的）。其余命令见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) §8。

顺序：**判断层 → 改源 → build（如需）→ 测试 → 生效 → 真机确认**；跳过测试直接进 GUI 是最常见的返工来源。

## 5. 生效矩阵

| 改了 | 生效 | 注意 |
|---|---|---|
| 主题/CSS、`assets/shell-*.js` | 保存 + 刷新 | iframe 重载，未保存编辑丢失；改注入清单要重载 Host |
| 客户端源码（`src/studio/studio-entry.js` 等） | `npm run build` 后刷新 | 同 iframe 重载 |
| Host 源码 `index.js`、`src/**/*.mjs` | 重载插件 + 刷新 | Studio 子进程重建 |
| `src/native/openfilm-persona.mjs` / `cordis.patch.yml` | 重载插件 + 刷新，**下一次建会话** | 已开会话仍用旧预设配置 |
| `vendor/templates/**`（含 `prompt.md`） | 下一次 `take=` / prepare | 已注入的旧块要等一次 prepare |
| `skills/**` | `node scripts/install-skills.mjs` | 只影响之后新建的会话 |
| `vendor/official-shell/ui/**` | 部署产物后重启 Studio | 清单不匹配 → `OFFICIAL_SHELL_UNAVAILABLE` |

**重载前先 `touch index.js src/**/*.mjs`**（加载器只重求值 mtime 变了的模块，症状是"改了没生效"；`npm run dev` 代劳）。插件不是热加载的：`restart-required` 就照 `nextStep` 重启，`host-start` 只证明 Host 重建。

## 6. 端口与变量

编辑器代理 `:47822`、调试窗口 `:47821`（`0`=关）；DSH Web 源必须是 `http://127.0.0.1:<port>`；变量全表 [`docs/reference/env-vars.md`](docs/reference/env-vars.md)。**桌面页面来源是 `dsh-app://app`**：相对 `/api/...` 会 404；`frame-ancestors` 要列 `dsh-app:`/`app:` 与回环端口，否则白屏。

## 7. 证据入口

出事先看 [`docs/playbooks/incident.md`](docs/playbooks/incident.md)。`POST /api/no996-openfilm/diagnose {projectId, conversation}` 给 `turns.sessions`、`instructions`、`bridge`、`archive`；日志在 `%TEMP%\dsh-openfilm\plugin.log` 与 `-frames.jsonl` / `-preset.json` / `-host.json`（重载后 `startedAt` 必须更新）。**不要靠猜形状**：ACP 字段以 `fake-acp-agent.mjs` 或真机日志为准。

## 8. 测试与提交

`npm test` 用 mock + `mkdtemp`；新增行为必须带测试。改上游界面时 `tests/kernel-shell-match.test.mjs` 与补丁一起更新。ESM、无 TS；Host 模块 `createX(deps)`，不在顶层做 IO；注释写"为什么"。提交信息：`类型: 结论 版本号`。

## 9. 进度在哪

**只在一处**：[`docs/STATE.md`](docs/STATE.md)（能用 / 待真机验 / 下一步 / 明确不做）。其他文档不写"已实现某版本"。把"待做"写成"已完成"是本仓最贵的错误之一。

## 10. 不要做

- 不要手改 `client.js`（会被 build 覆盖）。
- 不要给 `openfilm_draft` 加"保存/导出"；不要再引入未接线的授权/落盘旁路（已删的 `project-core` / `session-save` 一类）。
- 不要升级 `openfilm` 而不同步 `vendor/official-shell` 与 `OFFICIAL_COMMIT`（三处一起动）。
- 不要在浏览器侧接受任意 URL 当编辑器来源；不要声称预览、导出、渲染已接通——没接通。
- 不要在注入层承载权限、凭据、业务写操作。
- 不要让一条 ACP 会话服务多个对话（agent RPC 必须带 `conversation`）；不要把风格库/镜头卡/模板全文塞进 persona 或系统提示（ADR-0011 §2–4）。
- 不要把"已实现"的记录写进 `docs/`：已完成的删，待做的只在 `STATE.md` 写一句。
