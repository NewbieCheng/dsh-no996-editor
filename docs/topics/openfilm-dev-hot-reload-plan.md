<!-- doc
id: openfilm-dev-hot-reload-plan
reader: 插件维护者、需要改 OpenFilm 源码样式的开发者
fact-source: scripts/dev.mjs、scripts/dev-styles.mjs、scripts/upstream.mjs、src/official/official-shell.mjs、src/studio/studio-runtime.mjs、src/studio/studio-proxy.mjs、OpenFilm 0.3.2 @ 758b1a3 的 server.mjs 与 shell vite 配置
checked: 0.19.0
rot-if: 上游 Studio 改静态服务方式、shell 构建配置变化或方案拍板
-->

# OpenFilm 源码开发实时刷新方案（供拍板，未实施）

**一句话结论**：现在四个“开发脚本”都只是**提醒你按 F5**，没有一个接进页面的刷新通道；而且文档写的 `NO996_OPENFILM_DEV_SHELL=1` 在代码里**根本没实现**。要做成 React 那种“保存即刷新”，分三层走：先把已文档化的开发壳开关补上并让“保存→自动刷新”闭环（第 0/1 层），再上 Vite dev server 的真 HMR（第 2 层），最后把元素定位接进开发会话（第 3 层）。

调研基线：插件 `0.15.33`，OpenFilm `0.3.2 @ 758b1a3`，本机 DSH `0.2.2-rc.3`。本轮只读源码、不改产品行为；用户已确认本机调试安装后工作台可用（先前的 503 是本地 `file:` 安装漏了 `playwright-core`，已修并验证），本方案不重复处理该问题。

---

## 1. 现状：为什么现在改样式“一脸懵”

| 已有机制 | 实际做了什么 | 为什么不够 |
|---|---|---|
| [dev:styles](<../../scripts/dev-styles.mjs#L18-L26>) | 监听 `assets/theme/*.css`、`brand.json`，打印“已保存 → 刷新面板（F5）” | 只提醒、不刷新；只监听**我们**的主题 CSS，不监听上游 React 源码 |
| [dev(主开发脚本)](<../../scripts/dev.mjs#L7-L16>) | esbuild watch `studio-entry.js` → 重建 `client.js`；Host `.mjs` 改动 touch 一片文件 | 仍要手动刷新或重载插件；与 OpenFilm 源码无关 |
| [shell:dev](<../../scripts/upstream.mjs#L181-L194>) | 应用补丁 → `vite build` → 拷到 `.dev/shell` | **每次改动全量构建**；结果还要重启 DSH + F5 才看得到 |
| 上游自带 `pnpm dev` | `vite build --watch` + Studio 重启；注释明写“reload the page” | 上游自己也没有 HMR，只做增量重建，刷新仍靠人 |
| [resolveOfficialShell()](<../../src/official/official-shell.mjs#L17-L39>) | 永远校验 `vendor/official-shell/manifest.json`，只返回 `vendor/official-shell/ui` | `NO996_OPENFILM_DEV_SHELL=1` 在 [开发文档](<../DEVELOPMENT.md#L56>)、[上游手册](<../playbooks/upstream-bump.md#L55>)、`shell:dev` 输出里都写了，**代码里没有任何分支**——`.dev/shell` 从来没被加载过 |

两个关键事实决定了方案边界：

1. **Studio 不是开发服务器。** 上游 [server.mjs](<../../.upstream/no996-integration/packages/openfilm/studio/server/server.mjs#L1400-L1419>) 的 `sendEditor()` 只发静态 dist：`/assets/*` 带 `cache-control: immutable`（内容哈希文件名），其余路径统一回 `index.html`（`no-store`）。没有文件监听、没有 HMR WebSocket。`editorDir` 参数可换目录，但换的仍是**另一份静态目录**。
2. **面板的页面被我们的代理重写过。** [studio-proxy.mjs](<../../src/studio/studio-proxy.mjs#L308-L342>) 在 `index.html` 里注入原生桥、诊断器、工作区种子；[主题 CSS](<../../src/studio/studio-proxy.mjs#L429>) 也是逐次从磁盘读后内联进去的。这是**现成的刷新注入点**：任何 dev 客户端都能从这里进页面，且无需改上游。

另外，上游 shell 的 [vite 配置](<../../.upstream/no996-integration/apps/desktop/shell/vite.config.ts>) 已经带 `@vitejs/plugin-react`（dev 模式自带 Fast Refresh），并用 `twoTrees()` 把 `@/` 分别解析到 `studio/ui/src/` 与 `chat/src/` 两棵树——**React 真 HMR 所需的上游条件已经具备**，缺的只是让 DSH 面板去连 dev server，而不是连静态 dist。

> Windows 提示：此前已复现 libuv 对 `%TEMP%` 8.3 短名（`ADMINI~1`）递归 `fs.watch` 崩溃。监听目录必须落在无短名别名路径（如仓库内 `.upstream/...`），或显式改用轮询；这套开发链路必须在真机上按这条约束验证。

---

## 2. 三条技术路线与取舍

| 路线 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 静态重建 + 自动刷新** | 保留静态 `editorDir`；watch 源码 → `vite build --watch` → 写 `.dev/shell` → 通过注入的 SSE/WS 客户端触发页面 reload | 改动最小、最稳；CSS 和 TSX 都覆盖；不碰鉴权链 | 整页刷新，React 组件状态不保留；构建 1–3 秒 |
| **B. Vite dev server + 真 HMR** | dev 模式启动 Vite dev server；面板经由代理加载它的 `index.html`/模块/HMR WebSocket，`/api/*` 仍回 Studio | 真正的 React Fast Refresh 与 CSS HMR，保留组件状态；保存即更新 | 要处理 HMR WebSocket 经代理转发与鉴权、HTML 重写复用、路径/源目录白名单、Studio key 不泄漏 |
| **C. 仅 CSS 热注入** | 注入一个 dev `<link>`/`<style>`，watch 改文件后换 href，不刷新页面 | 最快、状态保留、实现最轻 | 只覆盖已知路径的 CSS；TSX 内联样式/Tailwind/JS 计算样式无能为力 |

**建议**：B 是目标形态，但不能一步到位——先把开关和闭环补齐（路线 A 作为保底），再做 B；C 作为 B 的局部增强被吸收，不单独立项。

---

## 3. 分层方案

### 第 0 层：把文档里的开发壳开关真正实现（必须先做）

- 在 [official-shell.mjs](<../../src/official/official-shell.mjs#L17-L39>) 增加 Host-only 分支：`NO996_OPENFILM_DEV_SHELL=1` 时把编辑器目录解析为仓库内 `.dev/shell` 的**绝对路径**；跳过 manifest 校验，但保留“绝对路径、无符号链接、必须位于仓库内”的校验，并在日志里明确打 `DEV SHELL` 标记，避免误以为自己在看正式快照。
- `NO996_OPENFILM_DEV_HMR=1` 时走第 2 层的 dev server 目录解析；两个开关互斥，且只在该插件以开发模式启动时生效。
- 放行证据：单元测试（含关闭时不生效、越界/符号链接被拒）+ 真机 `shell:dev` 产物被加载。

### 第 1 层：保存即刷新闭环（路线 A，先让用户“不懵”）

- 新增开发壳监听脚本（拟名 dev-shell-watch，落在 scripts/ 目录）：监听**两棵源树**（`studio/ui/src`、`chat/src`）与主题 CSS；防抖后运行 `vite build --watch` 到 `.dev/shell`；构建成功后向 Host 的一个 dev-only 端点发“有新版本”信号。
- 在 [studio-proxy.mjs](<../../src/studio/studio-proxy.mjs#L308-L342>) 的 HTML 注入点加一段 dev-only 客户端：与 `/__dsh/dev/reload`（SSE 或 EventSource，复用现有认证的同源通道）保持连接；收到信号后 `location.reload()`；构建失败时在诊断条显示错误，不让用户对着旧页面干等。
- 客户端与端点仅在 dev 开关打开时注入/注册；正式包里这段代码不得改变生产页面行为。
- 放行证据：改一个 TSX 的颜色值 → 数秒内面板自动更新；改一个 CSS → 同样自动更新；构建失败有可见错误；关掉开关后页面无 dev 客户端。

### 第 2 层：Vite dev server 真 HMR（路线 B）

- 新增一条命令的开发编排脚本（拟名 dev-workbench，落在 scripts/ 目录，一个命令起全套）：对**隔离的**上游 checkout 应用补丁 → 以 `vite --config apps/desktop/shell/vite.config.ts` 启动 dev server（loopback、固定端口、只允许本机）→ 设置 `server.hmr` 的 path/clientPort 指向代理端口，使 HMR WebSocket 从面板同源出去 → 输出 DSH 应设置的 env 与地址。
- [studio-runtime.mjs](<../../src/studio/studio-runtime.mjs#L65-L109>) 在 dev HMR 模式下不再把 `editorDir` 交给 Studio 的静态服务，而是让代理把 `/`（编辑器页）与 Vite 模块路径（`/src/*`、`/@vite/client`、`/@fs/*`、`/node_modules/.vite/*`）转发到 dev server；`/api/*`、`/__dsh/*` 仍然回 Studio/Host。HTML 重写（原生桥、诊断器、工作区种子、主题注入）必须**同样作用于 Vite 返回的 index.html**，否则 dev 模式会丢掉我们的接入层。
- HMR WebSocket 升级请求走代理现有 WS 管线，并与普通请求一样校验会话/Host/Origin；Vite dev server 只听 loopback，日志不打印 Studio key。
- 放行证据（无头 Chrome，复用 `scripts/workbench-window-check.mjs` 的隔离 Studio + mock Host）：修改 checkout 里一个 TSX → 断言 DOM 文本/样式在**不发生导航**的情况下改变（Fast Refresh 工作）；修改一条 CSS → 断言 computed style 改变且页面未 reload；从非本机/未认证来源连 HMR WS 被拒；`/api/*` 仍由 Studio 应答。

### 第 3 层：元素定位 → 开发会话（DX 收尾）

- 当开发者用元素定位找到某个 OpenFilm 源文件时，把 `文件:行` 记录进一个 dev-only 的“当前开发目标”，开发脚本据此聚焦 watch、必要时打开该文件，并在面板角落显示一个小徽标：HMR 已连接 / 最近一次更新时间 / 构建错误。
- 更新 [开发文档](<../DEVELOPMENT.md>)、[上游手册](<../playbooks/upstream-bump.md>)、[注入登记表](<../reference/injection-registry.md>)：把“F5 才会变”改成真实行为，写清 dev 开关、隔离 checkout 要求、Windows 路径限制，以及**从 HMR 验证完仍要走 `build-official-shell` → `patches:split` → `patches:check`**（HMR 只是开发手段，不替代补丁系列）。

---

## 4. 安全与边界（不可妥协）

1. **默认关闭**：所有 dev 开关默认关；正式包不含 dev 端点/客户端注入，生产请求路径与今天逐字节一致。
2. **鉴权不降级**：Vite 转发与 HMR WebSocket 仍走现有 Host/Origin/会话校验；只听 loopback，不开放给局域网。
3. **密钥不出 Host**：Studio key 不能进 Vite 日志、HMR 消息或浏览器可见的 dev 配置；dev server 不应拿到 key。
4. **路径 containment**：`.dev/shell` 与 checkout 路径必须绝对、在仓库内、无符号链接；拒绝 `..` 逃逸。
5. **不碰用户资产**：dev 监听与构建只针对隔离 checkout 和主题源；不监听、不改写用户项目、会话或 `film.html`。
6. **HMR 不是放行捷径**：改完样式仍按 [上游同步手册](<../playbooks/upstream-bump.md>) 重放补丁、构建正式快照、跑 `npm run check`；真机验收才算完成。

---

## 5. 验证与放行条件

| 层 | 自动化证据 | 真机证据 |
|---|---|---|
| 0 | dev 开关解析/拒绝的单测；正式路径不受影响 | `shell:dev` 产物确实被面板加载（页面出现 dev 标记） |
| 1 | watch→build→发信号→reload 的 mock 测试；失败显示错误 | 改一处 TSX/CSS，面板数秒内自动刷新；关掉开关无 dev 客户端 |
| 2 | 无头 Chrome：TSX/CSS 改动后 DOM/computed style 变化且无导航；HMR WS 鉴权负测 | 元素定位改样式 → 面板保存即更新、状态保留；`/api/*` 正常 |
| 3 | 文档与脚本自检 | 一条命令起开发环，徽标状态正确，能复现一次完整“定位→改→看→落补丁” |

统一闸门：`npm run check` 全绿（lint/test/docs/brand/templates/patches），`npm run upstream:verify` 补丁仍可重放；Windows 上用仓库内无短名路径验证文件监听不崩。

---

## 6. 实施顺序与需要拍板的点

建议顺序：第 0 层 → 第 1 层 → 第 2 层 → 第 3 层，每层可独立回退、放行后再进下一层。第 0/1 层便宜且立刻解决“不刷新”的痛点；第 2 层是用户描述的 React 式体验，复杂度集中在代理转发与鉴权，建议在 0/1 的真机闭环稳定后启动。

**请拍板三点**：

1. **是否接受“第 1 层整页刷新”作为可用的中间态**？如果要求一开始就必须保留组件状态，则直接做第 2 层，周期更长。
2. **dev server 的启动方式**：接受“一条 `dev:workbench` 命令同时起 Vite 与开发壳”（推荐），还是坚持沿用上游 `pnpm dev` 再加我们的代理转发？前者可控，后者更贴上游但鉴权/端口更绕。
3. **元素定位联动（第 3 层）是否本轮要做**？若只要求“保存即刷新”，可先交付 0–2 层，第 3 层另排。

这份文档**不授权实现、安装、提交或发布**；拍板后再按[第 5 节的放行条件](#5-验证与放行条件)执行。
