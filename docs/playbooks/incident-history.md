<!-- doc
id: playbooks-incident-history
reader: 追溯历史故障的人
fact-source: 真实故障记录（2026-11）、%TEMP%/dsh-openfilm/plugin.log、docs/architecture
checked: historical
rot-if: 仅在补充历史背景或修复链接时复核；不能当作当前行为
-->

# 历史故障档案

> 本文保存原始故障记录及当时判断；不作为当前操作指南。最新排查流程见 [incident.md](incident.md)。

> 先给**证据等级**，再给结论。这个仓库历史上最贵的两个错误是"改对了代码但没到 Host"和"把症状当根因"。
>
> **档案是历史记录，不是当前架构手册。** 多条案例针对旧 ACP 子进程；当前会话走 Host 内原生 `sessionController`，先看 [`../ARCHITECTURE.md`](../ARCHITECTURE.md) 和 `native-session` / `native-prompt-failed` 等实际日志。不要按旧案例启动 ACP、删除用户数据或假定旧日志仍存在。

## 1. 排查顺序（不要跳）

```text
1) 同一路由用 curl 打一次        → 请求到没到 Host？
2) 看页面 location.origin        → dsh-app:// 下相对 /api 是 404
3) 看 plugin.log 的最后 20 行     → 阶段、耗时、错误类别
4) 看 %TEMP%/dsh-openfilm-frames.jsonl → 一轮对话的真实分片
5) 重载插件（disable→enable）     → startedAt 必须变
6) 才去看代码
```

重载前先保存未保存的编辑；重载或重启可能中断活动工作台。`startedAt` 更新只能证明 Host 重建，不能证明 GUI 已应用；管理器返回 `restart-required` 时按提示整应用重启，再在页面核验。

## 2. 故障档案

### 2026-11-16 · iframe 每 ~9s 重挂；`stream disconnected` + `/api/version` aborted

**现象**：面板能开，但红字 `agent.events: stream disconnected`，底栏 `[网络] /api/version signal is aborted`；时间轴偶发闪一下。

**证据**：`plugin.log` 里 `ticket-redeemed active` 从 2 一直涨到 10+，间隔约 9s，伴随 `bootstrap` + `drag-probe boot`。

**根因**：`RecoveryGate` 探 `/api/version`（Studio 会等 npm，waitMs 4000）并与 4s Abort 赛跑 → 误判 miss → `no996-openfilm:restart` → iframe 整页重挂 → SSE 死、进行中的 version 请求被 abort → 再 miss。

**改法**：探 `/api/health`；Abort 不计 miss；restart 时清 misses。补丁 `230-RecoveryGate.patch`。

### 2026-11-16 · 长思考后中断；只见思考不见工具；菜单模型 ≠ 实跑

**现象**：思考一两分钟后红条 `ACP_REQUEST_FAILED` / `OFFICIAL_AGENT_FAILED`；「你好」也「已中断」并报 `stream disconnected`；整轮只有冗长思考，没有工具行/回答；菜单显示 `cbcn/…` 而日志是 `deepseek-official/deepseek-flash`。

**根因（多层，勿混成一个）**：

1. **模型静默回退**：spawn overlay 用 `dsh-opencode-go`，acp 无适配器 → `acp-model-fallback` → 落到 official；菜单未诚实反映。
2. **工具行被丢掉**：`ourToolName` 只认 `server=openfilm`，Host MCP 名是 `no996-openfilm` → `localToolActivity` 返回 null（阶段 2：补丁已 bake，待真机验工具行）。
3. **两种中断**：C1=`session/prompt` `-32603`；C2=页面重载后 `OFFICIAL_AGENT_STREAM_LOST`（SSE 死了，子进程可能还在跑）。
4. **燃料**：`openfilm_transcribe` `EXTRACT_FAILED` 连打；`openfilm_frame` 因把 `ctx.llm` 当函数调用而 `TypeError`。

**改法（Host 已动；壳另轮）**：turn 日志不计 stream 占槽；diagnose/`sessionState` 暴露实跑模型与 fallback；`STREAM_LOST` 文案改为「页面连接断了」；frame 接受 llm 服务对象；转写 EXTRACT 返回「不要立刻重试」。壳：认 `no996-openfilm` 后 bake。旧计划文档已移除；本条保留当时的排查背景。

**边界**：长轮空 `-32603` 在减负后再取证；侧栏全部模型同步进 acp 不在本修范围内。

### 2026-11-15 · 每段话都说两遍，上一轮的思考跑到下一轮开头

**现象**：回答和思考叠字（"那那今天先…"、"TheThe user said…"），长句子整段重复；发下一条消息时，
开头出现上一轮的思考（"user 想干什么"）。

**一眼分辨**：把真机一轮的 tap 帧和 `session/update` 一起抓下来重放（`.tmp-capture-turn.mjs` 那类
一次性 harness）。看快照与它概括的 delta 谁先到：快照在前 = 顺序错，后 = 合流错。

**根因**：`sync`/`seal` 绕过 30 ms 的 delta 队列直接写 socket。快照先到、被它概括的 delta 后到，
页面先把快照写进行、再把 delta 追加到快照后面——同一段写两遍。换轮时补发上一轮思考的 `seal`，
页面按"当前轮"落行，于是旧思考写进新消息开头。重放证据：旧顺序文本 340 字符（提交值 95）、
思考 470（提交值 181）；新顺序 95/95、181/181。

**改法**：所有帧走同一条有序队列；换轮只清空思考不 seal，思考改在 attempt 结束时 seal；帧带 `turn`，
页面丢弃更旧的帧；快照用 `preferLonger` 覆盖、绝不拼接（`mergeStreamText` 在互不为前缀时会拼接）。
回归测试 `acp-stream-tap.test.mjs` 钉住"快照只概括它之前的 delta"。

**边界**：思考行默认收起、展开最高 280px 是同一版改的界面，不是这个 bug 的原因。

### 2026-11-15 · 回答"隔一会儿蹦出一团"：增量没到页面，不是播放器坏了

**现象**：回答不是一个字一个字写出来，而是隔一会儿弹出一整段，再隔一会儿又一段。
0.15.18 已经删掉了"事后逐字回放"，所以这不是假播放——是 **live 帧根本没到**。

**一眼分辨**（先看日志，别先改页面）：

| 日志 | 含义 |
|---|---|
| 没有 `acp-stream-hello` | 这个子进程没有 tap（没注入 / 加载失败） |
| 有 hello，但每轮 `acp-stream` 的 `deltas` 是 0 | tap 在、帧没出来（事件名或帧形状随 DSH 版本漂了） |
| 有 `acp-stream-silent`（reason `tap-absent` / `connected-no-frames`） | 该轮只有提交后的整段，面板已降级 |
| `agent-trace` 的 `kinds` 里有 `stream=N` | 帧到了页面（N 就是收到的帧数） |

**根因**：`spawnArgs()` 把模型覆盖层和 tap 覆盖层塞进同一个数组，`ensure()` 在模型覆盖层被拒时
`openWith([])` 重试，把 tap 一起丢了。日志证据：`acp-stream-connected` 全程只出现一次，且属于一个
300 ms 后就被替换的子进程（`no adapter registered for provider "openai-codex"` → `acp-model-fallback`）。

**改法**：覆盖层拆成 `{model?, tap?}`，回退只丢模型；tap 连上先发 `hello`；每轮记
`acp-stream`/`acp-stream-silent`；`/diagnose` 的 `turns.stream` 给 `connected/deltas/textCommits`。
旧 ACP 方案的设计文档已移除；当前方案见架构文档。

**边界**：`acp-stream-connected` 只证明"有个 socket 接了"，`acp-stream-hello` 才证明"这个子进程带 tap"。

### 2026-11-14 · 工作区/剪辑区开关会凭空消失，之后切不回来

**现象**：侧栏左上那个「工作区/剪辑区」开关偶尔不见了；有时点导航里的「视频创作」，侧栏自己跳进剪辑区，
再想切回来时开关已经没了。

**根因**（两处，叠加）：
1. `mount()` 是**一次性**的：`findHeader()` 返回 null 就直接 `cleanup()` 把开关删掉。锚点条件是
   "span 文本 ∈ {工作区,会话} + 有 input + ≥2 个 button"——切分区、React 换标签、侧栏折叠、
   插件重启让列表请求 404，任一条命中都会删掉它；恢复只能靠 MutationObserver 等到一次 `childList` 变动，
   而折叠/纯 CSS 变化根本不产生变动。
2. 自动跳转是 `document` 上的捕获监听，**任何**文本为「视频创作」的按钮都会切换模式，不只是导航条目。

**改法**：锚点两段式（先认带 `data-no996-switch-host` 的 header，再认中文标签）；找不到不销毁，
保持节点并 1 秒重试（可见时），`resize`/`focus` 也重试；连续 3 次失败自动退回工作区并把官方列表还回去；
恢复写 `page-switch-remounted` / 丢失写 `page-switch-lost`（detail: no-header / reverted-workspaces）。
自动跳转只认 `findPanelEntry()` 找到的那个导航条目。

**补记（0.15.9）**：修完自愈后出现「工作区 ⌄ 工作区」并排——官方标签的 span 被 React 重建，
而隐藏只在挂载那一刻做过一次。现在 `syncHeaderActions()` 每趟都藏（跳过自己的），并删掉重复开关。

**边界**：改的是注入层（B2），不是官方壳；真机复现前只能说"按代码条件修掉了已知的两种路径"。

### 2026-11-15 · 拖文件显示"禁止"：不是壳禁止，是页面没接

**现象**：从资源管理器拖视频进面板，光标一路"禁止"；同一个编辑页在 Chrome 里打开却能拖。

**根因**：官方对话页只在输入框卡片上挂了 `onDragOver`/`onDrop`，其余区域没有 handler（"素材丢这里"
那块是静态 div）。浏览器对没有 `preventDefault` 的区域就显示"禁止"。

**误判与纠正**：先怀疑 DSH 桌面端（Electron）的 `dragDropEnabled` 默认值吞掉了事件。查 `app.asar`
后推翻：DSH 前端自己在文档级监听 `dragenter/dragover/drop` 并读 `dataTransfer.files`，preload 还
暴露了 `__DSH_HOST_PATHS__.pathFor`（`webUtils.getPathForFile`）——**事件到得了渲染进程**。

**改法（两步，第一步不够）**：
1. 两个 A1 补丁把整页变成投放区；路径由 DSH 页面代答，拿不到就回落到复制入库。**发布后仍然"禁止"** ——
   因为事件根本没进那个 frame。
2. 真因在承载官方壳的 `<iframe>`：`src/studio/studio-panel.mjs` 给它加了 `sandbox` 属性。**Chromium 拒绝把
   桌面文件拖进带 sandbox 的 frame**，连 `dragover` 都不派发，所以第一步的 handler 一次也没执行
   （对照：Atlassian Forge 的沙箱 iframe 有同一症状，页内拖拽却正常）。0.15.11 去掉 `sandbox`，
   保留 URL 校验与 `allow` 列表。

**真因（2026-11-15，实测确定）**：这台机器上的 DSH 是**以管理员权限**运行的。

- DSH 主窗口进程令牌 `integrity=high(elevated)`、`elevationType=full`；`explorer.exe` 是 `medium`。
- Windows 的 **UIPI** 默认禁止较低完整性进程向较高完整性窗口投递拖放通知，所以窗口一条事件都收不到：
  DSH 自带输入框、内置浏览器、我们面板全部"禁止"，而 Chrome（medium）里同一页面拖放正常。
- 判据：`npm run check` 之外，看 `plugin.log` 的 `host-start.elevated`；为 `true` 就是这个原因。
- 修法：**用普通权限启动 DSH**（不要"以管理员身份运行"）。插件层无解——`ChangeWindowMessageFilterEx`
  只放行旧的 `WM_DROPFILES`，对 Chromium 的 OLE 拖放无效。

**完整的取证方法**已整理进规范仓库 `dsh-harness-remix`：
[CASE-drop-refused](https://github.com/NewbieCheng/dsh-harness-remix/blob/main/docs/CASE-drop-refused.md)
（五处拦截点、三层探针与判读表、探针纪律、UIPI 与 sandbox 两个真凶、兜底顺序）。

**教训**：页面里写对了 handler 不等于事件会到——先确认事件有没有到这一层，再改处理逻辑。
iframe 的 `sandbox` 是"事件还没出生就被拦掉"的典型；**进程完整性级别**是更早、更彻底的一种。

### 2026-11-14 · 左删右还在：两边读同一份记录，但只有一边会重读

**现象**：在剪辑区删掉一条对话/一个项目，右侧对话下拉里仍然看得到；插件重启后两侧也会各说各话。

**根因**：两侧都读项目的 `.film/chat`，但缓存策略不同——左侧每次操作后 `refresh()`，右侧
`App.tsx` 的 `useState(() => loadSessions(projectKey))` **只在切换项目时读一次**，`chat-store` 还按
项目缓存整份记录。没有任何外部变更的监听，于是"删掉的"只在内存里消失。

**改法**：两侧都加 10 秒自读（页面可见时）+ 左侧 focus 重读；右侧 A1 补丁
（`apps/desktop/chat/src/App.tsx`、`lib/chat-store.ts` 的 `refreshChatSessions`），payload 变才重绘。
当前会话被删时回到空态，不跳到别的对话。

**边界**：轮询是最终一致，最坏 10 秒；要"秒级"就得上 Host 推送，代价是新增一条 SSE 与跨 frame 的投递。

### 2026-11-14 · 思考过程看得见了：官方把 thought 行扔了

**现象**：对话正常回复，但永远看不到思考。日志里 `agent_thought_chunk=1`，面板也 `seen:6`
全收到——内容到了，就是没画。

**根因**：`apps/desktop/chat/src/lib/agent-activity-runs.ts` 的 `buildRuns` 里有一句
`if (item.kind === 'thought' || isEphemeral(item)) continue;`。它在"思考只是状态行"的年代是
对的；后来上游加了 `ThoughtRow`（流式展开、结束折叠成"思考 N 秒"），却没人把这一句改回来——
**`ThoughtRow` 从写下那天起就是死代码**。

**改法**：A1 源码补丁，thought 作为独立 run 进入列表（不进工具折叠组）。补丁在
`patches/140-agent-activity-runs.patch`，`scripts/build-official-shell.mjs` 的 PATCHED 白名单
同步加了这个文件。

**边界**：ACP 一轮只发 1 个 message chunk，所以"逐字流式"改不了；能修的是思考先出现、回答整段到。

### 2026-11-14 · 删除项目/对话两头都报错：只认 Studio 的项目列表

**现象**：剪辑区 ⋯ 里删除对话和删除项目都弹"删除失败，请稍后再试"。

**根因**：两个入口都先用 `verifyOfficialProject`（拉 Studio `/api/projects`）确认项目；Studio
列表没刷新或根本没索引这个文件夹时就是 404，客户端把 404 折成一句泛泛的失败文案，真实原因被吞。

**改法**：
- 身份来源加兜底：Studio 不认就用 ACP 绑定的 `cwd`（`resolveDeleteTarget`，日志
  `delete-attempt` 里记 source）；目录移动仍由 `project-trash` 守卫；
- 客户端不再吞码：把服务端返回的码/HTTP 状态直接显示出来，并指向 `plugin.log`；
- `delete-failed` 日志记录失败码。

**边界**：没有绑定、Studio 也不认识的项目仍然拒绝删除——那种情况没有可信路径可用。

### 2026-11-14 · 「一直在处理中」：子进程留在退役默认模型上

**现象**：面板里提问后一直「仍在处理 36s」，不报错、没有回复、没有思考，等多久都一样。

**根因**：ACP 子进程 session 打开后，若 `ctx.agentDefaultModel.currentSelection()` 存在但没交出
值（或该 Host 版本没有这个服务），Host 的 `adoptDefaultSelection` 就什么都不设，子进程留在它自己
退役的默认 `deepseek-official/deepseek-v4-flash` 上。这个模型既不回话也不报错，turn 永远跑不完。

**怎么分辨**：`plugin.log` 有 `acp-default-effort` 但**没有** `acp-default-model`，且这一轮日志里
只有 `acp-ready` 没有 `agent-trace`。

**改法**：拿不到 Host 选择时读 profile 的 `agent-default-model`
（`readProfileDefaultModel`，`acp-profile-models.mjs`），子进程一上来就是侧边栏那个模型与
思考强度；`acp-profile-models.test.mjs` 覆盖有/没有两种情况。

**边界**：只读了 desktop 那份 profile 的 patch；`ctx.agentDefaultModel` 真给出值时仍以它为准。

### 2026-11-14 · 思考过程看不见：先分「没发」还是「没显示」

**现象**：对话能回，但从不出现思考过程，只有「仍在处理」。

**实测结论**（不是猜的）：

| 模型 | 一轮里 `agent_thought_chunk` | 回复 |
|---|---|---|
| `opencode-go/deepseek-v4.1-flash`（侧边栏默认） | **0 个** | 正常 |
| `deepseek-official/deepseek-flash` + 思考强度 max | 正常，实测 82 字推理 | 正常 |

面板渲染没问题：官方 `ThoughtRow` 流式时展开、一轮结束折叠成「思考 N 秒」。
**要看到思考，模型选 DeepSeek-V4.1-Flash（官方）。** 侧边栏用 opencode-go 的话，那边同样不会有思考。

**探针方法**（30 行，不花 GUI，也不改任何文件）：直接拉起 `dsh --profile acp`，`initialize` →
`session/new` → `session/set_config_option` → `session/prompt`，数 `session/update` 的 kinds。
注意那个模型选项是**分组**的（`options[].options[]`），照下标取会拿到 `null`。

**可观测**：面板每轮把收到的 kinds 回报 Host，现在写进 `plugin.log`（`agent-trace`）。

### 2026-11-14 · 对话全挂、模型只剩「默认」：路由 handler 里一个未声明的变量

**现象**：面板 `OpenFilm capability unavailable: agent:prompt — [503]
ACP_REQUEST_FAILED`；模型菜单只剩「默认」；`plugin.log` 每两秒一轮
`mcp-client(no996-openfilm): initial connection or tool synchronization failed`
→ `acp-session-failed` → `official-rpc-failed channel:"agent:models"`。

**根因**：MCP 端点的 handler 读了一个不存在的变量。控制器拆路由模块时，工厂的入参
叫 `isDisposed`，handler 里却写着 `if (disposed)`——每次请求都在 `res.setHeader`
之后抛 ReferenceError。Host 把这当成请求失败，回了 **400 空 body**，还带着我们刚设的
`cache-control: no-store`；ACP 子进程连不上端点，`session/new` 失败，于是模型、对话、
思考强度全没了。

**怎么一眼分辨**（这次靠这三条）：

| 路径 | GET 返回 | 含义 |
|---|---|---|
| 已注册的 exact 路由（`/bootstrap`） | 405 | handler 跑到了 |
| 没注册的路径 | 401 | 插件作用域守卫 |
| 我们的 MCP 路由 | **400 + `cache-control: no-store`** | handler 进得去、抛在了里面；`no-store` 是我们自己加的 |

**为什么先误判成"DSH 保留路径"**：当时 `/api/<plugin>/mcp` 看着像 DSH 的约定；换名后
400 依旧，才回去读 handler 源码。教训写在下面"反复出现的坑"里。

**改法**：`isDisposed()`；新增 `chat-route.test.mjs` 直接调 handler，覆盖
405 / 503 / 200 / 500 四条路径；`mcp-self-check`（每次发凭据前 Host 自己 POST 一次
`initialize` 并记状态码）保留——这次就是它把 400 摆到台面上。

**边界**：只修了这一个 handler。其他拆分出去的 handler 是否有同类未声明变量，靠同样的
"真调一次"测试补。

### 2026-11-14 · 插件「启用失败」：Cannot access 'registerRoute' before initialization

**现象**：插件管理状态「异常」，红条 `1 entry did not activate dsh-openfilm`，
面板完全打不开。与 2026-11-12 那条 `trackRoute` 是同一个病的新位置。

**根因**：路由拆模块后，`createSystemRoutes({ register: registerRoute })` 排在
`const registerRoute = router.register;` 之前；同作用域先读后声明是 TDZ。

**为什么 CI 是绿的**：没有任何测试真的**调用** `createStudioController`——拆出去的
模块有测试，静态 `import` 只解析不执行函数体。

**改法**：`createRouter` 与三个绑定整体上移到第一个使用者之前；
`tests/declaration-order.test.mjs` 断言三个绑定紧挨着 router，且四个 `create*Routes({`
都在绑定之后。

**边界**：只钉住这一类（路由绑定）。其他"声明顺序"错误仍靠读代码发现。

### 2026-11-12 · 「本地服务」里的模型不能靠注入加

**现象**：给「设置 → 服务 → 本地服务」加 SenseVoice，先在 `assets/shell-ui.js` 里往弹窗 DOM 追加卡片。视觉上和原生的行不是一种东西，用户明确拒绝注入。

**根因**：这个弹窗属于 Studio（L2），不是桌面壳。上游源码（pin `758b1a3`）：

- 渲染：`packages/openfilm/studio/ui/src/components/settings/LocalModels.tsx`
- 元数据：`packages/openfilm/studio/server/local-models.mjs` 的 `ABOUT`
- 文件清单：`packages/openfilm/library/local-models.json`
- 下载源：`studio/server/library.mjs`，`OPENFILM_LIBRARY_URL`
- 缓存：`OPENFILM_LIBRARY_CACHE`，默认 `~/.openfilm/library`

UI 完全由 `/api/local-models` 的数据驱动，所以**不需要重建 Studio UI**：补 `ABOUT` + `local-models.json` 两处数据，行就按原生组件渲染。

**做法**：`src/studio/studio-library-patch.mjs` 在 Host 启动时幂等改这两处（装在 `node_modules/openfilm`，pnpm 重装会覆盖）；`src/studio/studio-library-mirror.mjs` 起回环镜像并把 `OPENFILM_LIBRARY_URL` 指过去。

**坑**：`npm run upstream:fetch` 用 `git fetch --depth=1 origin <sha>` 拉 pin commit 会报 `couldn't find remote ref`——对象其实在 clone 里，直接 `git -C .upstream/openfilm checkout --force <sha>`。另外 `openfilm` 的 `exports` 只开子路径，要 `import.meta.resolve('openfilm/package.json')` 再 `new URL('.', …)` 才拿得到包根。

---

### 2026-11-11 · 服务断线后点「重启」白屏

**现象**：长时间未使用后服务断开，点「重新启动工作台」白屏。

**根因（四条并存）**：

- 旧故障按钮跳到回环调试地址 `/editor`，那个入口只签发地址并重定向，不负责启动失联的 Studio；
- 旧 `running` 是内存 `ready` 位，上游失联也可能仍为真 → 改成受限的本地 `/api/health` 实际探测；
- 旧白屏检测只看首次启动，iframe 后续导航到错误页没有提示 → 导航重新计时，注入脚本在页面真正渲染后补发 `boot`；
- 桌面 `dsh-app://app` 的相对 `/api/...` 不到 Host，**不能把 404 当 Studio 断线**。

**边界**：模拟测试覆盖断开恢复、清理失败、并发、消息来源、导航超时；**真实 GUI 的断线恢复仍未验证**。

---

### 2026-11-12 · 删除项目报 500，弹出一整段 PowerShell

**现象**：官方壳项目列表点删除，红条里是 `Command failed: powershell.exe …`，文件夹还在。

**根因**：项目文件夹同时是它自己对话 Session 的工作目录，DSH 工作区监视持有目录句柄，Windows 拒绝把仍被监视的目录移进回收站；上游把整条命令和 stderr 原样塞进 500 的 `error`，壳的 fetch 包装又把 5xx 当可重试显示。

**改法**：代理在 `DELETE /api/projects/:id` 转发前先归档该项目的对话（`stopActivity`）释放监视；仍失败时把 `Command failed`/`powershell.exe` 一类 5xx 改写成 409 + 人话，避免壳重试和原始命令泄漏。

**边界**：409 只保证"不再出现原始命令"，不保证目录一定删得掉。

---

### 2026-11-12 · 项目对话总是掉进「未分组」

**现象**：每次打开项目，侧栏出现该项目的文件夹（工作区建对了），但对话留在「未分组」。

**根因**：两层形状假设错。`workspaceController.create({ path })` 返回 Remote 值 `{ workspace: { workspaceId, sessionIds, … }, created }`，代码只读 `created.id` / `created.workspaceId`，于是每次打开都报 `WORKSPACE_CREATE_NO_ID` 并退回 `{ cwd }` 建会话。工作区分组只认 `workspace.sessionIds`：`SessionSummary` 没有 `workspaceId`，`workspace/insertSessionBefore` 只移动已归组的会话，`attachSession` 不在契约里。

**改法**：解包 `created.workspace`（旧扁平形状兼容）；会话一律带 `workspaceId` 创建；建完回读 `sessionIds` 作为归组证据。存量空会话换新，有历史的不自动换绑，报 `WORKSPACE_SESSION_UNGROUPED`。

**边界**：非空旧会话没法归位（无 attach API）；Host 代码要重启 DSH 才生效。

## 3. 反复出现的坑（按主题）

| 主题 | 症状 | 现在的做法 |
|---|---|---|
| 顺序假设 | 严格顺序丢增量；反向把 unchanged 当流失效 | 按 index 去重，允许跳跃与接管 |
| 归因假设 | 只认 `user/message`，真实事件是 `agent/inbox/spliced` | 两种归因都认，只有 `kind:'user'` 且 rpcId 不匹配才算冲突 |
| 状态假设 | 绑定表不校验归档 → 每次发送 503；`running` 位不代表上游活着 | 发送前探针 + 健康检查 |
| 分组假设 | 把"会话属于哪个工作区"当会话字段 | 只认 `workspace.sessionIds` |
| 平台假设 | `dsh-app://` 下相对 `/api` 是 404 | 先看 `location.origin` |
| 重载假设 | 把"重启插件"当万能药，但请求没到 Host | 先 `curl` 同一路由 |
| 构建假设 | 手改 `vendor/official-shell/ui` 不重算 manifest | 启动即 `OFFICIAL_SHELL_UNAVAILABLE`，必须 `shell:bake` |
| 文档假设 | 测试数、文件数写死在多份文档里 | 数字不抄，能生成就生成 |
| 双实例 | profile 里同时有用户层与 bundle 条目，两个实例都 apply，第二个抛 "already registered"，整个插件 failed | 只留一个条目 |
| TDZ | 路由注册块写在 `const trackRoute` 之前 | `Cannot access 'trackRoute' before initialization`，apply 抛错 = 整个插件失败 |
| 拆分漏参 | 控制器拆成路由模块后，handler 读了作用域里已不存在的变量（`disposed` vs `isDisposed`） | 400 + 自己设的响应头；真调一次 handler 的测试才能抓到 |
| 模型假设 | 子进程留在退役默认模型上 → 不报错也不回话，永远「处理中」 | 启动即同步 profile 的 `agent-default-model`；日志里必须有 `acp-default-model` |
| 能力假设 | 以为「有思考选项」＝「会发思考」；不同 provider 返回 0 个 thought chunk | 用 acp 探针数 kinds，别用菜单猜 |

## 4. 新增一条故障记录

写这四段就够，不要写流水账：**现象**（用户看到什么）、**根因**（可复核的机制）、**改法**（改了哪里）、**边界**（这次没解决什么）。
根因如果指向某个设计选择，去 `decisions/` 写/改 ADR，而不是留在本文。
