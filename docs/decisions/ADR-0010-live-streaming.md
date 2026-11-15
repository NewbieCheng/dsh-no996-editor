<!-- doc
id: ADR-0010-live-streaming
reader: 维护者、要改对话流式链路的人
fact-source: src/acp-stream-tap.mjs、src/acp-client.mjs、src/acp-agent-service.mjs、src/studio-controller.mjs、patches/190-local-agent-run.patch、%TEMP%\dsh-openfilm\plugin.log、DSH 0.2.2-rc.3 安装包内 dsh-agent / dsh-agent-loop / dsh-acp / dsh-api-session-controller
checked: 0.15.21
rot-if: DSH 在 ACP 上提供 durable 增量事件（届时删掉 tap），或 acp 子进程不再由本 Host 拉起
-->

# ADR-0010：对话的“真流式”重做——live 帧按 attempt 认领，提交时替换而不是拼接

- 状态：生效（0.15.19 实现 P0–P3，0.15.20 修帧顺序；面板实机验收见 `docs/STATUS.md` §4）
- 日期：2026-11-15
- 取代：无（`0.15.18` 的 tap 思路保留，接线与合流重做）

## 1. 现象与代价

面板里回答不是“一个字一个字写出来”，而是**隔一会儿蹦出一整段**，再隔一会儿又蹦出一段。
人看到的是“假流式”，但代码里既没有事后回放，也没有缓冲整段——`0.15.18` 已经删掉了
`useRevealedText()`。所以问题不在“播放”，在**增量根本没到页面**。

代价：这是对话的主视图。它一坏，用户对整个面板的信任就没了（“连打字机都是假的”），
而日志里没有任何一行说明“这一轮没有 live 帧”，所以它躲过了一整版验收。

## 2. 事实（可复核，不是设想）

### 2.1 ACP 只发已提交的整段

`dsh-acp/src/updates.ts` 的 `assistantUpdates()` 跑在 durable `assistant/message` 上，
一条消息里的每个 block 变成一个 `agent_message_chunk`（整段文本），没有 partial/delta。
模型一轮里“说一段 → 调工具 → 再说一段”，页面就收到两三个整段——正是“蹦出一团”。

### 2.2 token 只在子进程里看得见

`dsh-agent/src/runtime-types.ts` 的 `AssistantStreamFrame` 是 `start` / `chunk` / `end`，
`chunk` 是 `StreamChunk`（`text-delta`、`reasoning-delta`、`tool-call-delta`、`block-start`、
`block-end`、`usage`、`finish`），带 `attemptId`、`revision`、`turn`、`step`、`index`、`time`；
`dsh-agent-loop/src/agent.ts` 对每个 provider chunk 都 `dispatch.emit('agent/assistant-stream', { frame })`。

### 2.3 官方 Web 的做法（照抄的对象）

`dsh-api-session-controller/lib/index.js`：

- `ctx.on('agent/assistant-stream', ({ agent, frame }) => … , { global: true })`，按 `agent.session.id` 累积；
- 每个连接拿到 `assistant-stream` 帧（Web 侧投影成 `assistant/live-chunk`，带 `attemptId`、`turn`、`step`、`chunk`）；
- 客户端 `ClientAssistantStream` 用 `attemptId + block index` 折叠成“正在写的 attempt”，
  durable settlement 到了就**整块替换**（retire transient），不是拼字符串。

要点：**身份是 attempt，权威是提交**。我们的 tap 只搬了文本，没搬身份，合流只能靠“最长前缀胜”。

### 2.4 我们这条链路（现状）

| 段 | 文件 | 做什么 |
|---|---|---|
| 子进程注入 | `src/studio-controller.mjs` `spawnArgs()` | 写两个 `--patch` 覆盖层：模型、tap（`- insert:` + 绝对 `file://` URL） |
| 子进程侧 | `src/acp-stream-tap.mjs` | 订阅 `agent/assistant-stream`，把 `text-delta` / `reasoning-delta` 以 30 ms 合批写回 loopback |
| 传输 | `src/acp-client.mjs` | spawn 前监听 `127.0.0.1:0`，端口 + 一次性 token 走 env，帧转成 `emit('stream', …)` |
| 扇出 | `src/acp-agent-service.mjs` → `official-event-hub` → `official-event-stream` | `{kind:'stream'}` 走 SSE |
| 页面 | `patches/190-local-agent-run.patch` | `LocalAgentTurn.stream()` 把增量写进 `text:<turn>:<part>` / `thought:<turn>`，提交时 `mergeStreamText` |

### 2.5 真正的故障：模型回退把 tap 一起丢了

`src/studio-controller.mjs` 的 `spawnArgs()` 把**两个覆盖层放进同一个数组**；
`src/acp-agent-service.mjs` 的 `ensure()` 在模型覆盖层被拒时这样重试：

```js
opened = await openWith(extraArgs);   // 模型覆盖层 + tap 覆盖层
} catch (error) {
  opened = await openWith([]);        // ← 连 tap 一起丢了
}
```

于是只要模型覆盖层失败，**存活下来的子进程没有 tap**，整轮只有提交后的整段。

日志证据（`%TEMP%\dsh-openfilm\plugin.log`，本机 0.15.18）：

- `acp-stream-connected` 全文件**只出现一次**：`05:09:26.810`；
- 300 ms 后 `acp-request-failed -32603 no adapter registered for provider "openai-codex"` →
  `acp-model-fallback` → `acp-exited`；
- `05:09:29.654` 新子进程 `acp-ready`，**没有** `acp-stream-connected`，这才是活下来的那个；
- 它那一轮 `agent-trace` 是 `seen=26`、`kinds` 合计 26（`agent_thought_chunk=7 agent_message_chunk=2
  usage_update=7 tool_call=5 tool_call_update=5`）——**一个 `kind:'stream'` 都没有到页面**。

### 2.6 传输本身是好的（实测）

用一次性 harness 直接拉起 `dsh --profile acp --patch <模型覆盖层> --patch <tap>`，走
`initialize → session/new → session/prompt`（一句短回答，3.3 s）：

- tap 的 `apply` 执行、socket 连上、token 准入通过；
- 一轮 33–45 个 `text-delta`，每个 1–9 字符（真 token 级，不是整段）；
- `end` 后补一个 `seal`（整段快照）；
- 普通 `ctx.on(...)` 与 `{ global: true }` 两种注册**都**能收到帧——注册方式不是问题。

结论：**tap 机制成立，缺的是“每一个活着的子进程都带上它”，以及“带上之后不丢、不拼错”。**

### 2.7 现有合流的三个洞（与本次现象无关，但会继续咬人）

1. **没有身份**：页面按自己的 `part` 计数器决定写哪一行（`text:<turn>:<part>`）。
   提交晚到、或中间插了工具调用时，增量可能落到错误的行；唯一修复是 `end` 的 `seal`
   （`mergeStreamText` 最长前缀胜），所以中途会“错一下再改回来”。
2. **没有序号**：丢一帧不可见，只能等 `seal` 修；长回答里 `seal` 要到 attempt 结束才来。
3. **思考的 seal 每个 attempt 都发整段**：一轮 50 次工具调用 = 50 份完整思考文本（O(n²) 流量），
   页面靠 `mergeStreamText` 去重才没看出问题。

## 3. 决定

保留“子进程 tap + loopback + SSE”这条**唯一能拿到真 token** 的通道，重做三件事：
**接线、身份、合流**。明确不做：不在页面上做“事后逐字播放”（伪流式），不缓冲整段再吐。

### 3.1 接线：覆盖层按用途拆开，回退只丢模型

- `spawnArgs()` 返回 `{ model?: string, tap: string }` 而不是一个扁平数组；
  `createAcpClient` 接受 `args` 数组不变，由 service 组装。
- 模型回退重试时**只**去掉模型覆盖层，tap 永远在。
- tap 连上先发 `{t:'hello', v, pid}`，Host 记 `acp-stream-hello`；这样“tap 在不在”有正面证据，
  不是靠“没报错”。

### 3.2 身份：帧带 attempt，页面按 attempt 认领

帧形状（子进程 → Host → 页面同一份）：

```json
{ "t": "hello",  "v": 1, "pid": 1234 }
{ "t": "start",  "attempt": "<session>:1", "turn": 3, "step": 1, "sessionId": "…" }
{ "t": "delta",  "attempt": "<session>:1", "index": 12, "kind": "text", "turn": 3, "text": "…" }
{ "t": "sync",   "attempt": "<session>:1", "kind": "text", "turn": 3, "text": "<该 attempt 至今全文>" }
{ "t": "seal",   "attempt": "<session>:1", "kind": "text", "turn": 3, "text": "<该 attempt 全文>" }
{ "t": "seal",   "attempt": "<session>:1", "kind": "thought", "turn": 3, "text": "<本轮至今思考全文>" }
```

- `attempt` 来自 `frame.attemptId`（DSH 已给），`index` 来自 `frame.index`，`turn` 是 DSH 的轮次；
- `sync` 每 250 ms 或每 32 帧发一次整段快照：丢帧的修复窗口从“attempt 结束”缩到 250 ms；
- 思考的 `seal` 在**每个 attempt 结束时**发（仍在同一轮内），换轮时只清空、不发旧轮的思考。

**顺序是契约的一部分（0.15.20 的教训）。** 所有帧走同一条队列：`delta`、`sync`、`seal` 的先后必须
与产生它们的 chunk 一致。`sync` 一旦插队（先写 socket，而 delta 还在 30 ms 批里），它概括的 delta 就会
在快照之后到达，页面把同一段话写两遍——真机重放：旧顺序文本 340 字符 / 提交值 95，新顺序 95 对 95。
换轮时也不能补发上一轮的 `seal`：页面按“当前轮”落行，旧思考会被写进新消息开头。

页面侧（上游补丁 `local-agent-run.ts`）：

- `attempts: Map<attempt, rowId>`；`start` 分配行，`delta` 只认领自己那行，`sync`/`seal` 覆盖；
- 提交（`agent_message_chunk`）到达时**替换**该 attempt 的行文本（提交是权威），行 id 不变，
  避免 DOM 跳动；未认领的提交按现有 `part` 逻辑新建；
- 帧的 `turn` 比已见的旧 → 丢弃（上一轮的迟到帧不许写进这一轮）；
- `index` 跳号 → 立刻丢弃本 attempt 的增量、等 `sync`，不再“拼一个可能错的”。

### 3.3 合流：提交覆盖增量，快照绝不拼接

`mergeStreamText` 保留给“实时 vs 存档”的对账；live 行用 `preferLonger`（`packages/shared/src/contract.ts`）：
同文本取更长的一边，绝不 `cur + next`。`mergeStreamText` 在两边互不为前缀时会拼接，一次乱序就变成
肉眼可见的重复段落（0.15.20 之前的症状）。三种写入语义分开：`delta` 追加，`sync`/`seal`/提交覆盖。

### 3.4 平滑：页面按帧合并渲染

网络 30 ms 一帧、页面每帧一次 store 通知 → 长对话里 React 跟不上，观感就是“一顿一顿”。
页面把增量先写进 ref 缓冲，`requestAnimationFrame` 合并一次 `emit()`；
Markdown 的增量重扫（`patches/040-Markdown.patch`）继续用。官方客户端是逐 chunk 更新，
但它的会话是虚拟列表；我们的转写是整表重渲，必须自己合并。

### 3.5 可观测：没有 live 帧必须留下痕迹

- 每轮 `done` 记一行 `acp-stream { deltas, seals, silent }`；
- 有文本提交却零 delta → `warn acp-stream-silent { reason }`（tap 没注入 / 没连上 / 没帧）；
- `/diagnose` 增加 `stream: { connected, deltas, lastAt }`；
- 页面 `agent-trace` 的 `kinds` 里单列 `stream=N`，让“到了几帧”一眼可见。

### 3.6 保留（不动的东西）

- 图片：live 帧只搬文本；图片走提交的 `agent_message_chunk`（`assistantBlockToAcp`），
  与附件、参考图、工具卡、plan、审批行完全无关，本次不改它们的形状；
- 思考：仍然一轮一行（`thought:<turn>`），`seal` 语义改成“整轮覆盖”；
- 无 tap 时的降级：就是今天的行为（整段到达），但会多一行 `acp-stream-silent`。

## 4. 分阶段（每阶段都能单独验收）

| 阶段 | 内容 | 改动面 | 验收 |
|---|---|---|---|
| **P0** | 覆盖层拆分；回退保留 tap；`hello` + 帧计数 + `acp-stream-silent` | `studio-controller.mjs`、`acp-agent-service.mjs`、`acp-stream-tap.mjs` | 真机一轮：日志有 `acp-stream-hello`，`acp-stream.deltas > 0`，页面上字是连续长出来的 |
| **P1** | 帧带 `attempt/index`，`sync` 快照，思考 seal 收敛到 turn | `acp-stream-tap.mjs`、`acp-client.mjs`、`acp-agent-service.mjs` | 丢帧注入测试：跳过 `index` 后 250 ms 内自动补齐；长回答无错位 |
| **P2** | 页面认领 attempt、提交覆盖、rAF 合并渲染 | `patches/190-local-agent-run.patch` + 重建 `vendor/official-shell` | 60 Hz 下 ≥ 20 次可见更新/秒；行 id 稳定不跳；思考/工具卡不变 |
| **P3** | `/diagnose` 流健康、文档、CHANGELOG | `official-chat-rpc`/`studio-controller`、`docs/ARCHITECTURE.md`、`CHANGELOG.md` | `npm run check` 全绿 |

P0 是**修 bug**，不改变任何语义，风险最低；P1/P2 是“规范化”，可以在 P0 验收后单独发版。

## 5. 代价

- 多一条必须维护的私有通道：DSH 改 `AssistantStreamFrame` 形状就得跟着改（`start/chunk/end`
  与 `chunk.type` 都是版本敏感点），升级 DSH 必须复跑 2.6 的实测；
- `sync` 快照让流量从“增量”变成“增量 + 周期全文”，长回答（>64 KiB）要设上限并降频；
- 页面按 attempt 认领，需要上游补丁再动一次 `local-agent-run.ts`（第 4 次），
  每次升上游都要重放；
- 仍然是**进程内事件**的二手转发：不是 ACP 契约的一部分，官方随时可能不保证。

## 6. 证据入口

- 真机日志：`%TEMP%\dsh-openfilm\plugin.log`（`acp-stream-connected` / `acp-stream-hello` /
  `acp-stream` / `acp-stream-silent` / `acp-model-fallback`）；
- 一次性实测 harness（不进仓库）：拉起 `dsh --profile acp` + 两个覆盖层，走完
  `initialize → session/new → session/prompt`，统计 `text-delta` 数量与大小；
- 上游补丁：`patches/190-local-agent-run.patch`（`stream()` 与 `dispatch` 的 `kind:'stream'` 分支）；
- 测试：`tests/acp-agent-service.test.mjs`（回退保留 tap）、`tests/acp-client.test.mjs`
  （hello/seal/跳号/断连）、`tests/kernel-shell-match.test.mjs`（构建产物与补丁一致）。
