<!-- doc
id: playbooks-dev-live
reader: 新手开发者、调样式和改界面的同学、智能体
fact-source: scripts/dev-up.mjs、scripts/dev-up.ps1、scripts/dev-live.mjs、src/dev/index.mjs、src/dev/dev-browser-portal.mjs、src/studio/studio-proxy.mjs、src/studio/studio-proxy/plugin-surface.mjs、src/host/distribution.mjs、scripts/pack-tgz.mjs、.upstream/openfilm/packages/openfilm/studio/ui/src/App.tsx、WorkbenchAccount.tsx、lib/navigate.ts、studio/server/bridge.js
checked: 0.19.11
rot-if: dev:up / 门户 Origin 分裂、viewerOrigins、film EDITOR、/?library=1、/?loginPreview=1 或打包流程变化
-->

# 零基础开发指南：实时热更新、调样式与打正式包

## 开发模式：启动 / 重启 DSH（抄这条）

仓库根目录、本机 `desktop` profile 已 `link:` 到本仓时：

| 你要做什么 | 命令 | 说明 |
|---|---|---|
| **第一次开 / 全套起来** | `npm run dev:up` | 起 Vite（若未听 `:47825`）→ **杀掉并重启** DeepSeek Harness → 带上 DEV 环境变量 |
| **只重启 DSH**（Vite 已在跑） | `npm run dev:dsh` | 等价 `npm run dev:up -- --dsh-only`；改了 `src/**/*.mjs`、代理、`viewerOrigins`、角标变黄时用这个 |
| 额外开样式拾取条 | `npm run dev:up -- --style-lab` | |
| 不杀已有 GUI（少用） | `npm run dev:up -- --no-kill` | |

`dev:up` / `dev:dsh` 启动时带上的环境变量（必须在**进程启动前**设好，事后改无效）：

- `NO996_OPENFILM_DEV_HMR=1`
- `NO996_OPENFILM_VITE_ORIGIN=http://127.0.0.1:47825`
- `NO996_OPENFILM_DEV=1`

起来后打开：**[http://127.0.0.1:47821/](http://127.0.0.1:47821/)**  
右下角绿色 **`DEV HMR · 已连接`** 即通。

- 账号抽屉 **「登录页」**（DEV）→ `/?loginPreview=1`，盖上真实 `LoginGate`（DEV 免登时 `auth:logout` 无效，只能这样预览）
- 项目库首页单独打开：地址栏进 `/?library=1`
- 登录页上点「返回工作台」会清掉 `loginPreview` 并回到 `/?library=1`

| 口 | 用途 |
|---|---|
| `47825` | Vite（只给代理用，别当工作台打开） |
| `47821` | 开发者浏览器 / Agent 开放工作台（免登录、免 Ticket） |
| `127.0.0.2:47822` | DSH 侧栏「视频创作」面板（严格鉴权） |

找不到 exe 时先设：`$env:DSH_APP = "F:\apps\DSH_harness\DeepSeek Harness.exe"`  
或：`powershell -File .\scripts\dev-up.ps1`

不走 npm、手敲等价流程：

```powershell
# 仓库根目录
npm run dev:live               # 终端 1，保持开着；已在跑可跳过
# 终端 2：
Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Stop-Process -Force
$env:NO996_OPENFILM_DEV_HMR = "1"
$env:NO996_OPENFILM_VITE_ORIGIN = "http://127.0.0.1:47825"
$env:NO996_OPENFILM_DEV = "1"
Start-Process -FilePath "F:\apps\DSH_harness\DeepSeek Harness.exe" -WorkingDirectory "F:\apps\DSH_harness"
# 打开 http://127.0.0.1:47821/
```

> **Host（`src/**/*.mjs`）改完**：角标会提示重载；要干净模块缓存就再跑 **`npm run dev:dsh`**。只 F5 页面不够。

---

## 一句话：改不同文件怎么生效

| 你想改什么 | 改哪个目录 | 保存后怎么生效 |
|---|---|---|
| OpenFilm 界面 React / TSX / Tailwind 样式 | `.upstream/openfilm/`（例如 `packages/openfilm/studio/ui/src/`） | **Vite Fast Refresh** |
| 不加班主题配色 / CSS 覆盖 | `assets/theme/*.css`、`brand/brand.json` | **原地热替换** |
| 壳叠加脚本（DOM 补丁） | `assets/shell-ui.js` | 自动通知工作台刷新 |
| DSH 侧栏 / 面板外框 | `src/studio/studio-entry.js` 等 | `esbuild` 重建 `client.js` |
| Host 后端（`.mjs`） | `src/**/*.mjs`、`index.js` | touch 模块图 → 重载插件或 `npm run dev:dsh` |

> [!TIP]
> **Windows**：监听目录不要放在带 `~1` 短名的 `%TEMP%`（如 `ADMINI~1`）路径下。

---

## 一次性准备（只需做一次）

```powershell
npm ci
npm run upstream:fetch
```

确认 `~/.dsh/profiles/desktop/package.json` 里是：

```json
"@newbiecheng/dsh-no996-editor": "link:F:/Dev/Desktop-Projects/dsh-openfilm"
```

正式用户包仍走 npmjs；本机调试用 `link:`。

---

## 开发门户规律：同一类 Origin 分裂

`http://127.0.0.1:47821` 是**公开门**；背后的 editor / film / plugin 是**临时口**（端口每次启动都变）。浏览器页的 `location.origin` 永远是门，不是临时口。DSH 侧栏（`127.0.0.2:47822`）往往「看起来正常」，Chrome 开 `47821` 却挂——多半是这一类，不是两套互不相关的病。

```text
页面 Origin = http://127.0.0.1:47821          ← 门（viewer）
editorOrigin = http://127.0.0.1:<临时>         ← 代理内部编辑器
filmOrigin   = http://localhost:<临时>         ← 预览 iframe /p/…
pluginOrigin = http://localhost:<临时>         ← /s/ 工作台模块、/f/ 文件
```

**以后同类问题怎么下手（按顺序）：**

1. 看 **页面** `location.origin` 是不是 `47821`（或 `localhost:47821`）。
2. 看失败资源的 **真实 URL**：是临时口、`/s/`、`/p/`，还是门上的路径。
3. 对可疑请求试带 `Origin: http://127.0.0.1:47821`：`curl -sI -H "Origin: …"` —— **403 / ACAO 不对** → CORS 或代理 Origin 闸门。
4. 预览卡住「Drawing the first frame」：打开 film iframe 的 `film.html`，搜 `const EDITOR =` —— 必须等于**页面 Origin**（门），不能等于临时 `editorOrigin`；否则 `postMessage(..., EDITOR)` 被浏览器静默丢掉，DSH 侧栏却正常。
5. 修的时候优先问：**这个响应/消息认的是 editor，还是也该认 `viewerOrigins`？** 已有入口：`viewerOrigins`（门户传入）、`plugin-surface.mjs`（`/s`/`/f` CORS）、`studio-proxy.mjs`（film `EDITOR` / film ACAO / Origin 放行）。
6. Host（`.mjs`）改完必须 `npm run dev:dsh` 或重载插件；只靠 F5 不够。

| 现象 | 同一类里的哪一刀 | 证据 | 怎么办 |
|---|---|---|---|
| `Failed to fetch …/s/…/ui.js`、剪辑工作台起不来 | 门 Origin 拉 plugin 口模块，CORS 只认临时 editor | Network：模块 200 但无门的 `Access-Control-Allow-Origin`，或 OPTIONS/GET 403 | `viewerOrigins` + `plugin-surface` 把 viewers 当 editor；`npm run dev:dsh` |
| 带 `Origin: 47821` 打 `/p/…/film.html` → **403** | film 代理拒门 Origin | `curl -I -H "Origin: http://127.0.0.1:47821" http://localhost:<film>/p/…` | film `rejectionReason` / ACAO 放行 viewers（同 `studio-proxy`） |
| 预览一直 **Drawing the first frame**；DSH 侧栏正常、Console 几乎无报错 | film 桥 `EDITOR` 写成临时 editor，门收不到 `ready`/`seeked` | iframe `src` 是 `localhost:<film>/p/…`；HTML 里 `EDITOR` ≠ `47821`；1–2s 内无 `openfilm-film` 消息 | film HTML 重写：有 `viewerOrigins` 时 `EDITOR = viewers[0]`（门） |
| Vite DEV 下 `Failed to resolve module specifier 'openfilm/workbench/…'` | 开发态 `ctx.bundle` 空，生产 import map 未注入 | 查看 HTML 是否缺 `openfilm/workbench/*` import map | 上游 `workbenches.ts`：无 bundle 时注入 `/@fs` + `/@id` 的 DEV import map |
| 「开发模式无需退出」点不了 / 想调首页样式却被踢回项目 | DEV 没有可清的会话；裸 `/` 会 `go` 最近项目 | App 在无 `id` 时自动 `go(/projects/<last>)` | 账号抽屉 → **回到首页** → `/?library=1`（强制项目库，不自动进最近片） |
| 直接打开 `47825` 白屏 | Vite 只给代理用 | 地址栏是 47825 | 用 `47821` |
| `desktop` 不能 `dsh --profile desktop` | Electron 独占 | CLI 报错 | 起 `DeepSeek Harness.exe`，环境变量在**启动前**设好 |
| 管理员身份跑 DSH | 拖放 UIPI | 拖文件无反应 | 普通权限（`dev:up` 默认如此） |
| Host 改了界面仍旧 | 模块缓存 / 旧进程没带 DEV | 角标黄、或 `plugin.log` 的 `startedAt` 没变 | `npm run dev:dsh` |

回归锚点（改代理时顺手跑）：`tests/plugin-surface.test.mjs`、`tests/dev-browser-portal.test.mjs`、`tests/studio-proxy-film-viewer.test.mjs`。

虚拟机或网络盘文件监听不灵时：`npm run dev:live -- --poll`，再 `npm run dev:dsh`。

---

## 调样式与改界面（日常）

### A. 主题 / CSS
改 `assets/theme/*.css` 或 `brand/brand.json` → Ctrl+S → 角标提示样式热更新，不丢弹窗。

### B. React / TSX
改 `.upstream/openfilm/...` → Ctrl+S → Vite Fast Refresh。需要点选元素时：`npm run dev:up -- --style-lab`。

### C. Host `.mjs`
保存后角标变黄 → 重载插件；仍不对就 `npm run dev:dsh`。

---

## 报错怎么看

- 落盘：`$DSH_HOME/no996-openfilm/logs/diagnostics-YYYY-MM-DD.jsonl`（默认 14 天 / 50 MiB）
- 页面：红条「查看诊断日志」、顶栏小虫子、设置 → 开发者
- Host：`%TEMP%\no996-editor\plugin.log`、`%TEMP%\no996-editor-host.json`

---

## 改完怎么打正式包

```powershell
node scripts/build-official-shell.mjs <上游检出> --output vendor/official-shell.next
# 确认后替换 vendor/official-shell
npm run patches:split
npm run shell:bake
npm run check
node scripts/pack-tgz.mjs
```

> [!IMPORTANT]
> 正式 `.tgz` **不含** `src/dev/`；会打 `dsh.releaseBuild = true`。即使用户设了 `DEV_HMR=1`，`:47821` 也是 404。本地调试包才用 `node scripts/pack-tgz.mjs --dev`（输出到 `.dev/`）。
