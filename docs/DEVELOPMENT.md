<!-- doc
id: development
reader: 新开发者、智能体
fact-source: package.json、cordis.patch.yml、src/*.mjs、scripts/*
checked: 0.16.1
rot-if: 启动时序、请求路径、模块职责或构建方式变化
-->

# 开发文档 — no996-editor / No996 Studio

>
> 版本与测试数量以 `package.json` 和 `node --test` 的实际输出为准，本文不抄数字（抄了就会过期）。

---

## 1. 它是什么

一个 DSH 插件：把官方 OpenFilm 视频工作台整页搬进 DSH 侧边栏的「视频创作」面板，并让官方界面里的对话使用 DSH 的模型与会话。

```text
┌──────────────────── DSH Web 页面（127.0.0.1:<DSH 端口>） ────────────────────┐
│ 侧边栏「视频创作」                                                            │
│ ├─ main          → 占位（只上报矩形，panel-keepalive）                        │
│ └─ shell.overlay → 真面板（fixed，跟随占位），内含 iframe                      │
│                     iframe → http://127.0.0.1:47822/                          │
└──────────────────────────────────────────────────────────────────────────────┘
│ 同源 fetch / SSE
┌──────────────────── DSH Host 进程（Cordis Loader） ──────────────────────────┐
│ index.js → apply(ctx)                                                         │
│ ├─ ctx.tools.register(openfilm_*)     只对本项目会话可见                 │
│ └─ createStudioController(ctx, startStudioProxy)                              │
│    ├─ Studio 运行时：openfilm/studio.startStudio({port:0}) → 临时端口          │
│    ├─ 代理：47822，校验 cookie/Host/Origin，转发 HTTP+WS                       │
│    ├─ 官方对话桥：official-rpc → Host 原生 sessionController；事件 → SSE    │
│    ├─ 主题层：assets/theme/*.css 注入（开发期）                                │
│    └─ 调试控制台：127.0.0.1:47821（可关）                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

三条必须记住的：

- Studio 上游只 bind 临时端口，key 不出 Host；浏览器只看得见代理端口 47822。
- 面板挂 `shell.overlay` 而不是 `main`，是为了切页不重载 iframe。

---

## 2. 启动时序

1. Host 启动，Loader 应用 `cordis.patch.yml`：插入插件行与 `openfilm-video-editing` 预设行。
2. `index.js` 的 `apply` 注册工具与控制器。控制器立刻做非懒的事：校验 DSH Web 源是 `127.0.0.1`、写预设激活报告（有界重试）、启模板控制台、订阅归档集合。
3. 点开面板 → `POST /api/no996-openfilm/bootstrap` → 首次装配：懒加载 `openfilm/studio`、校验版本、`startStudio({port:0})`、为浏览器 Origin 建代理，返回 `{editorOrigin, mode, webOrigin}`。
4. 面板校验地址（`http:`、同源 host、无 user/pass/path/query/hash）后设 iframe `src`。
5. iframe 通过 `postMessage` 上报 `boot` / `project`（项目 ID 存 `localStorage`）。
6. 20 秒没收到 `boot` → 面板显示诊断块，让用户整段贴回。

`NO996_OPENFILM_DEV_SHELL=1` 时，编辑器目录换成 `.dev/shell`（`shell:dev` 的产物），跳过 manifest 校验；仅开发用，不要发布。

---

## 3. 请求路径

| 场景 | 路径 | 校验点 |
|---|---|---|
| 打开面板 | `POST /api/no996-openfilm/bootstrap` | DSH 浏览器 peer + 同源 surface |
| 诊断 | `POST /api/no996-openfilm/diagnose {projectId?}` | 只读；带项目时回每轮帧计数与归属 |
| 取图 | `GET /api/no996-openfilm/attachment?id=<64hex>` | 浏览器 peer + 只读附件库 |
| 归档 | `POST /api/no996-openfilm/archive` | 浏览器 peer + 本机 Host/Origin + 1 KiB |
| 模板 | `/api/no996-openfilm/templates`、RPC `template:*` | 白名单 ID、独占创建、拒符号链接 |
| 对话 | `POST /__dsh/official-rpc {channel:'agent:prompt'}` | 项目 ID 每次经 Studio 实时列表校验 |
| 取消 | 同上 `agent:cancel` | 同上 |
| 流式 | `GET /__dsh/official-events?projectId=…` | 项目作用域、每连接一次订阅 |
| 聊天历史 | RPC `chat:load` / `chat:save-*` / `chat:archive*` | 归档项目只读 |
| 上传 | `PUT /__dsh/official-upload?projectId&name` | 交给 Studio 自己的 `assets/upload` |
| 页面日志 | `POST /api/no996-openfilm/client-log` | 枚举值，≤512 字节 |

**失败语义**：只回固定错误码（`DSH_ORIGIN_REJECTED` / `DSH_BROWSER_REQUIRED` / `OFFICIAL_*` / `PROJECT_CONVERSATION_*`），不回原始异常；可选通道失败降级为 `null` 并记日志，不弹红条。

---

## 4. 模块职责

### Host 编排

| 文件 | 职责 | 风险 |
|---|---|---|
| `index.js` | `inject` 声明与 `apply` | 加依赖会改变加载时序 |
| `src/studio/studio-controller.mjs` | 路由、生命周期、代理工厂、RPC、系统提示、模板桥 | 高：信任判断汇集于此 |
| `src/studio/studio-runtime.mjs` | 懒加载并校验上游版本，`startStudio` | 中：版本 pin 与上游契约耦合 |
| `src/studio/studio-proxy.mjs` | 回环反向代理、WS、`/__dsh/*` 桥、HTML 注入 | 很高：放松一条就是安全回归 |
| `src/official/official-shell.mjs` | 校验 manifest（版本、commit、逐文件 sha256） | 高：改 ui 必须重生成 manifest |
| `src/project/workspace-archive.mjs` / `archive-bridge.mjs` | 归档集合的唯一 Host 视图 + 浏览器路由 | 高：浏览器可触达的写路径 |

`src/` 按故障域分目录，见 `AGENTS.md` §3。

### 对话桥（原生 DSH 会话）

`src/native/dsh-native-agent-service.mjs` 在 Host 内驱动 `ctx.sessionController`；`src/native/dsh-session-store.mjs` 保存项目和对话到会话的映射。`src/official/official-chat-rpc.mjs` 将页面请求交给服务，事件经 SSE 返回页面；影片预设及指令边界见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

旧 ACP 故障记录只作为历史参考，不能把旧子进程日志当作当前实现的必备证据。排障先看 [`playbooks/incident.md`](playbooks/incident.md) 和当前 `native-*` 日志。

### 影片工具

影片工具只对项目会话可见；注册和实际工具列表以 `src/tools/` 与运行时为准，避免在多处手抄数量。常用工具包括 `openfilm_film`、`openfilm_frame`、`openfilm_clip`、`openfilm_storyboard`、`openfilm_transcribe` 和 `openfilm_guide`。

`openfilm_cli` 只留只读动词：`doctor`（这台机器有什么）、`version`（固定的 OpenFilm 版本）、`skills` / `skill <owner/name>`（这部片可用的技能）。`look` / `render` 会启动 Studio，而内核在没有 `.film/opened` 时会在人的浏览器里开剪辑窗口。看画面用 `openfilm_frame`。

`openfilm_library` 的素材检索分两路（OpenFilm 0.4.0 起）：音乐 / 音效 / 贴纸仍走 Studio 的 `/api/get/library`；转场、特效、滤镜、文字由 Host 用固定版库自己的索引在进程内搜（[`src/tools/library-search.mjs`](../src/tools/library-search.mjs)），取用一律走 Studio 的 `saved/take`。这两类都是 CC0 免费素材，不经过任何计费服务。

### 客户端

`src/studio/studio-entry.js`（Slot 注册）、`studio-panel.mjs`（iframe、超时诊断、bootstrap 重试）、`panel-keepalive.mjs`（占位矩形）。`client.js` 是 `npm run build` 的产物，**不要手改**。

### 界面注入与主题

| 文件 | 职责 |
|---|---|
| `src/ui/shell-extras.mjs` | 读 `assets/shell-ui.js`（mtime 缓存）；登录门已进 shell 包 |
| `assets/shell-ui.js` | 官方壳的 DOM 叠加：模板、环境检查、账号条、故障卡 |
| `assets/shell-login.js` | 登录门参考实现（真机门是 `LoginGate.tsx`） |
| `src/ui/theme.mjs` | 按 surface 读 `assets/theme/*.css` 并生成 `<style>` |
| `brand/brand.json` + `src/ui/brand.mjs` | 产品名、颜色、链接、上游归属 |

### 上游补丁

`patches/series.json` + 每文件一个 `.patch`；`patch.diff` 是合并视图（生成物）。补丁放在 `vendor/official-shell` 之外，重新生成快照不会删掉它们。`scripts/build-official-shell.mjs` 打包快照，`scripts/upstream.mjs` 负责对账/重放。流程见 `playbooks/upstream-bump.md`。

---

## 5. 数据与存储

存什么、存在哪、哪些是真相哪些只是提示，见 [`reference/storage.md`](reference/storage.md)。

**永不删除**：用户 Session（只归档）、上游 `.film/`、项目文件（删除走回收站并由用户确认）。

## 6. 安全模型

三个信任假设、必须成立的校验、新增路由的模板，见 [`reference/safety.md`](reference/safety.md)。

一句话：这是本机回环集成，不是 OS 沙箱；注入层不承载权限、凭据、业务写操作。

## 7. 构建、安装、发版

```sh
npm ci
npm run check:quick # 开发中：变更文件语法、文本规则、可识别的相关测试；仍可能漏检
npm run check       # 提交前：全量 lint + test + docs/brand/templates/patches
npm run build       # src/studio/studio-entry.js → client.js
npm run shell:bake  # 发版前把主题烘焙进 vendor/official-shell/ui
```

安装 / 更新 / 发版（版本、CHANGELOG、STATE、打包、回滚）见 [`playbooks/publish.md`](playbooks/publish.md)。

---

## 8. 改完怎么让它生效

| 改动 | 构建 | 生效 | 代价 |
|---|---|---|---|
| `brand/brand.json`、`assets/theme/*.css` | 否 | 保存 + 刷新 | iframe 重载，未保存编辑丢失 |
| `assets/shell-ui.js` / `login-city.js` / `shell-login.js` | 否 | 保存 + 刷新（读盘 + mtime） | 同上；改注入清单要重载 Host |
| `src/studio/studio-entry.js` / `studio-panel.mjs` / `panel-keepalive.mjs` | **是** | 刷新 | 同上 |
| Host 源码 `index.js`、`src/**/*.mjs` | 否 | 重载插件 + 刷新；如要求整应用重启则按提示重启 | 活动中的工作台可能中断 |
| `vendor/templates/**` | 否 | 下一次请求即生效 | 无 |
| `vendor/official-shell/ui/**` | 是（上游） | 部署产物后重启 Studio | 清单不匹配 → `OFFICIAL_SHELL_UNAVAILABLE` |
| `cordis.patch.yml` | 否 | 重新 `dsh plugin add`（registry）或重启 Host | 已有会话不迁移 |
| 预设和 persona 配置（`cordis.patch.yml`） | 否 | 重载配置或重启 Host 后，新建会话验证 | 现有会话不自动迁移 |
| `skills/**` | 否 | 重载插件或重启 Host 后新建影片会话验证 | 影片预设从本包注册技能；已有会话不自动迁移 |
| `vendor/templates/<id>/prompt.md` | 否 | 下一次 `openfilm_library take=<id>` 即生效 | 无 |
| `src/native/instruction-inventory.mjs`（/diagnose 的注入清单） | 否 | 重载插件 + 刷新 | 无 |

Host 模块重载可能受模块缓存影响；修改后应核验实际运行版本。如果重载未应用变更，保存工作并按管理器提示完整重启 DSH，再验证原页面。现有 `npm run dev` 不应被视为递归监听整个 `src/` 的保证。

**零基础实时开发流程（Vite HMR + 热样式）见 [`playbooks/dev-live-guide.md`](playbooks/dev-live-guide.md)。**
运行 `npm run dev:live` 后配合 `NO996_OPENFILM_DEV_HMR=1` 启动 DSH，React/TSX 修改走 Vite Fast Refresh、主题 CSS 走原地无刷新替换；`src/dev/` 与调试工具会在 `scripts/pack-tgz.mjs` 打包时物理排除，不进入发布包。

管理器返回 `restart-required` 时：如实报告，并按 `nextStep` 完整重启 DSH；日志里的新 `host-start` 只证明 Host 重建，不证明 GUI 已应用。

---

## 9. 排查：先看证据

| 手段 | 内容 |
|---|---|
| OpenFilm 内置「错误与诊断日志中心」 | 顶栏小虫子按钮 / 底部红条「查看诊断日志」 / 设置 → 开发者；支持按层/错误码/TraceID 筛选、复制、问 Agent、导出、调整保留天数 |
| `$DSH_HOME\no996-openfilm\logs\diagnostics-YYYY-MM-DD.jsonl` | 全链路结构化诊断日志（UI / RPC / SSE / Host / NativeAgent / Studio），默认保留 14 天、上限 50 MiB 自动清理 |
| `POST /api/no996-openfilm/diagnose {projectId}` | `mode / studio / preset / proxy / permission / turns / grouping / log / bridge` |
| `%TEMP%\no996-editor\plugin.log` | JSON Lines，512 KB 轮转；密钥与路径自动脱敏 |
| `%TEMP%\no996-editor-frames.jsonl` | 原始帧（每轮覆盖） |
| `%TEMP%\no996-editor-host.json` | `{version,pid,startedAt}`；重载后必须更新 |
| `%TEMP%\no996-editor-preset.json` | 预设 `registered/ok/detail/raw` |
| 面板静默诊断 | 20 秒无 `boot` 自动显示并上报外层诊断，可整段贴回 |

`turns[].verdict` 是"面板为什么是空的"的判词：`no-frames-received` / `nothing-emitted` / `some-frames-dropped` / `emitted`。`grouping` 说明会话是否在项目文件夹下。

**不要靠猜分片形状**：`official-agent-events.mjs` 的 bug 必须用真实 `type` 名反推。

---

## 10. 测试

- `npm test`（等价 `node --test tests/*.test.mjs`）；只用 mock 与 `mkdtemp`，`OPENFILM_HOME` 指临时目录，不调真实模型。
- 覆盖重点：事件翻译与顺序、思考与工具行、错误分类、模板复制/限额/链接拒绝、草稿原子性与冲突、会话归属、`.film/opened`、CLI 动词收窄、诊断判词。
- 上游界面断言在 `tests/kernel-shell-match.test.mjs`：检查补丁里必须出现的标记（`data-thought`、`data-tool-name`、`kind:'image'`、`InlinePicture`），改界面时补丁要一起更新。
- 新增行为必须带测试；本仓历史 bug 大多是"逻辑没问题但顺序/形状假设错"。
- CI（`.github/workflows/ci.yml`）跑 `windows-latest`：`npm ci` → `npm run check` → 无构建产物 → 工作区干净。**只在 Windows 跑是有意的**（支持面就是 Windows 桌面集成，见 workflow 顶部注释）；加系统进矩阵要同时做真机验收。
- 行尾统一 LF（`.gitattributes`）：Windows runner 默认 `core.autocrlf=true`，不锁行尾时逐字节比较与钉死哈希会在 runner 上假红。

---

## 11. 升级上游

见 [`playbooks/upstream-bump.md`](playbooks/upstream-bump.md)。一句话：`package.json` tarball、`manifest.version/commit`、`official-shell.mjs` 的 `OFFICIAL_COMMIT` 三处一起动；补丁按文件重放，冲突按文件报告；运行时不要装 `latest`。

---

## 12. 已知边界（不是 bug）

- DSH 的 Web GUI 无法嵌入面板（跨源、无会话深链、无 embed 参数、`app.asar` 不可改）。所以"搬 DSH 的对话框"不存在，我们只搬表达。
- `window.openfilmNative` 是唯一消不掉的注入（网页没有原生桥）。
- 底部状态条（缓存命中 / 步数 / tokens）**故意不做**。
- 审批走 DSH 自己的界面；插件不会静默放行。
- 上游快照不是字节级一致：有本地改动的文件全部记录在 `patches/series.json`，打包器拒绝计划外改动。
