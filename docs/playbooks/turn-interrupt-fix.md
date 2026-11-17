<!-- doc
id: playbooks-turn-interrupt-fix
reader: 准备修「对话中断 / 只见思考 / 模型菜单与实跑不一致」的人
fact-source: %TEMP%/dsh-openfilm/plugin.log（2026-11-16）、acp-agent-service.mjs、src/official/official-facade.mjs、src/studio/studio-controller.mjs、patches/190-local-agent-run.patch、docs/decisions/ADR-0010-live-streaming.md、docs/playbooks/incident.md
checked: 0.15.22
rot-if: 模型回退策略、SSE 终态契约、或思考/工具分行渲染约定变了
-->

# 流程：修「长思考后中断」与「菜单模型 ≠ 实跑模型」

> 本文是**修复计划**，不是进度账。进度只写 [`../STATE.md`](../STATE.md)。  
> 证据来自 2026-11-16 真机：`plugin.log` 项目 `lsUCVRSBs8hH`，对话 `dsh-zqzfp0iayurmwilhpja` / `dsh-jw5rjy8ivipmwils4sl`。

## 0. 一句话

两件独立的事叠在一起：**（A）一轮里界面只剩冗长思考，然后中断**；**（B）菜单显示的模型不是子进程实际在跑的模型**。先让选择诚实，再让一轮里的思考/工具/正文可见，再收工具失败与长轮崩溃。不要一上来改 persona 或加新旁路。

## 1. 现象（用户看到的）

| 现象 | 证据等级 |
|---|---|
| 思考一两分钟后红条：`ACP_REQUEST_FAILED` / `OFFICIAL_AGENT_FAILED`（HTTP 503） | 高：`acp-prompt-failed reason=ACP_REQUEST_FAILED`，ACP `-32603` 且 `data:""` |
| 「你好」也「已中断」：`agent.events: stream disconnected` | 高：同秒 `OFFICIAL_AGENT_STREAM_LOST`；此前有 `host boot` → `bootstrap` → `ticket-redeemed active:2` |
| 整轮只有思考，没有工具行、没有回答正文 | 高：用户确认；同轮 `acp-stream textCommits:0`；Host 侧仍有 `mcp-tool-failed` |
| 菜单是 `cbcn / deepseek-v4.1-flash`，日志是 `deepseek-official/deepseek-flash` | 高：`acp-model-fallback`（`no adapter … dsh-opencode-go`）→ `acp-default-model … deepseek-official` |

## 2. 根因（按层，不要混成一个 bug）

### A. 模型选择不诚实（静默回退）

1. 子进程是 `dsh --profile acp`，侧栏/当前选择通过 temp overlay 注入（`spawnArgs` → `dsh-openfilm-acp-<provider>-<model>.yml`）。
2. 今天侧栏带着 `provider: dsh-opencode-go`；acp profile **没有**这个适配器 → `acp-request-failed` → `acp-model-fallback` → **丢掉模型 overlay 重拉**。
3. 新会话落在 acp 内置 `deepseek-official/deepseek-v4-flash`，再被 `adoptDefaultSelection` 拨到 `deepseek-flash`。
4. 页面菜单仍可显示用户以为选中的名字（或侧栏名），**没有把「回退已发生」写回 UI**。

权限（完全访问）**有接线**：改权限会 `reset` 子进程，下次 spawn 带 `DSH_PERMISSION_MODE`。默认本来就是 `danger-full-access`。权限问题与模型静默回退无关，不要当成「设置全没生效」。

### B. 一轮只见思考

1. 设计：思考一轮一行（`thought:<turn>`），避免 50 次工具冒出 50 个「思考了 Ns」（见 `patches/190-local-agent-run.patch`）。
2. 现场：`deltas≈8363`、`seals=33`、`textCommits:0` —— 几乎全是 reasoning 流，**没有正式回答段落**。
3. Host 侧工具确实在跑（同轮 `openfilm_transcribe`×4 `EXTRACT_FAILED`；后一轮 `openfilm_frame`×2 `TypeError`），但用户界面上**看不到工具行**。这不正常：工具应另成行；「思考里写打算调工具」≠ 工具卡片。
4. 怀疑点（修复时要先用一轮 turn 日志钉死，不要猜）：  
   - 数千帧 thought stream 是否压住 / 冲掉工具行的绘制；  
   - `agent-trace` 的 kinds 是**页面生命周期累计**，不能当「本轮有 tool_call」的唯一证据；  
   - 中断时 SSE 先断，终态失败，未完成的工具行被清掉。

### C. 两种中断机制

| 代号 | 日志 | 机制 |
|---|---|---|
| C1 | `acp-prompt-failed` + `ACP_REQUEST_FAILED`（`-32603` 空 data） | `session/prompt` 在子进程里失败；长轮 + 工具反复失败后常见 |
| C2 | `OFFICIAL_AGENT_STREAM_LOST` + 面板 `stream disconnected` | prompt 在 Host 侧跑完了，但 `emit(done)` 时**没有活着的 SSE 订阅**（页面中途重载 / EventSource 死了） |

C2 的时间线（「你好」那次）：思考中 → `drag-probe host boot` + `bootstrap` + `ticket-redeemed active:2` → 工具还在跑 → 终态 `STREAM_LOST`。

### D. 工具本身在失败（拉长思考、放大 C1）

| 工具 | 码 | 含义 |
|---|---|---|
| `openfilm_transcribe` | `EXTRACT_FAILED` | ffmpeg 抽音轨失败（见 `src/asr/asr-audio.mjs`） |
| `openfilm_frame` | `TypeError` | 抽帧路径抛了未归类异常（`mcp-tool-failed` 只记了名字） |

模型在思考里反复「再试转写/再抽帧」→ 轮次变长 → 更容易撞上 C1。

## 3. 明确不做（本计划边界）

- 不改剪辑导演 persona / 注入链（ADR-0011），除非 diagnose 证明指令链是中断原因。
- 不把预览/渲染/沙箱算进范围。
- 不「升级 openfilm」当修复手段。
- 不为了「看起来在流」重新引入假逐字回放。
- 不把侧栏所有自定义 provider 强行塞进 acp；**诚实失败优于静默 official**。

## 4. 渐进修复（按依赖排序）

原则：**每一阶段都能单独合并、单独真机确认**；后一阶段不依赖「猜前一阶段已经好了」。  
每阶段结束跑 `npm run check`；动了官方壳源码要 `npm run build` / 补丁流程（见 [`ui-change.md`](ui-change.md)）。

---

### 阶段 0 — 取证钉死（半天，先于改行为）

**目的**：把「工具事件有没有进本轮 transcript」和「菜单当前值 / 实跑值」变成可重复读的证据，避免修错层。

| 步骤 | 做什么 | 落点 |
|---|---|---|
| 0.1 | `/diagnose` 增加或核对：本轮 `session` 模型、effort、permission preset、`stream` 计数、`textCommits`；说明 `agent-trace.kinds` 是否累计 | `src/studio/studio-controller/routes/diagnose.mjs` 等 |
| 0.2 | 本轮 turn 日志不要被 stream 帧挤爆到丢掉 `tool_call`（今日 `TURN_LOG_EVENTS=2000`，一轮 stream 就上千）——至少按 `sessionUpdate` / `kind` 分类保留，或 stream 单独计数不占工具事件槽 | `src/studio/studio-controller/turns.mjs` |
| 0.3 | `mcp-tool-failed` 带上 `message` 截断（现有只 `code`），方便分辨 `openfilm_frame` 的 TypeError | `mcp-server.mjs` |
| 0.4 | 写一条最小真机剧本：新对话 → 选模型 → 发「你好」→ 丢短视频要转写；同时 tail `plugin.log` | 本文 §6 |

**验收**：同一轮能回答三问——实跑模型是谁？本轮有没有 `tool_call` 进 Host？`textCommits` 是否为 0？

**退出条件**：0.2/0.3 的测试补上；0.4 跑过一次并贴日志片段进 PR 描述（不要写进本篇当「已完成」）。

---

### 阶段 1 — 模型选择诚实（P0，优先）

**目的**：菜单显示的 provider/model **必须等于** 该对话 Session 当前值；回退必须可见、可拒绝，禁止「表面上 cbcn、实际 official」。

| 步骤 | 做什么 | 落点 |
|---|---|---|
| 1.1 | spawn 前识别「当前选择的 provider 在 acp 不可用」（已知：`dsh-opencode-go` 无适配器；也要覆盖 catalog 对不上的一般情况） | `spawnArgs` / `ensureChild` 回退路径 |
| 1.2 | 发生 `acp-model-fallback` 时：日志保留；**并向面板暴露**（RPC 或 start 结果里带 `appliedModel` + `fallbackReason`）；菜单 `currentValue` 改成实跑值 | `acp-agent-service.mjs`、`official-facade.mjs` / chat RPC、模型菜单补丁 |
| 1.3 | 用户在菜单里选一个 catalog 有、但 setConfig 会炸的值：失败要进气泡，**不要**假装选中 | `selectModel` + 面板错误展示 |
| 1.4 | 文档一句：OpenFilm 对话用 acp 子进程；侧栏 provider 名与 acp 适配器 id 不一致时会回退——以 `acp-session-model` 为准 | `DEVELOPMENT.md` 或本 playbook 引用即可 |

**验收（真机）**：

1. 故意选一个 acp 没有的 provider → 菜单最终显示的是实跑模型，或明确报错，**不会**继续显示无效选择。  
2. 选 catalog 内且 acp 有适配器的模型 → `acp-session-model` 与菜单一致。  
3. 权限改「完全访问」后新开一轮：子进程环境带对应 mode（可用既有 permission 路径；不必与 1 绑死）。

**测试**：`acp-model-fallback` 路径单测（mock：overlay 拒 → 无 overlay 成功 → 返回/日志带 reason）；菜单 currentValue 与 catalog 一致性。

**不做**：一次性复制侧栏全部自定义通道进 acp（那是更大的产品决策；若要做，另开 ADR，不阻塞本阶段）。

---

### 阶段 2 — 一轮可见性：思考 / 工具 / 正文（P0/P1）

**目的**：恢复「一句思考、工具行、回答正文」的可读结构；思考可以长，但不能独占、不能吞掉工具。

**已钉死的根因（源码层，两层）**：

1. `ourToolName` 一度只认 `server === 'openfilm'`，Host MCP 实际叫 `no996-openfilm` → 工具当「别人的 MCP」丢弃，界面只剩思考。
2. 认出来之后，`publicActivity` 对未知工具（全部 `openfilm_*`）仍返回 ephemeral `act.working`——只进状态条「正在处理 Xs」，**不进工具行**。所以 Host 明明跑了几十次工具，人眼只看到灰色「正在处理」在重置。

改法：`local-agent-run.ts` 认 `no996-openfilm` + 裸 `openfilm_*`，并用 `hostOpenfilmActivity` 把 Host 工具映到持久 act（转写→`audio.transcribe`、分镜→`film.review` 等）。已写入 `patches/190-local-agent-run.patch` 并重建 `vendor/official-shell`。**真机确认工具行可见前，不要把本阶段标成完成。**

| 步骤 | 做什么 | 落点 |
|---|---|---|
| 2.1 | 用阶段 0 的本轮日志确认：工具 `update` 是否到达 EventSource、是否进入 `LocalAgentTurn` items | turn 日志现在不计 stream 占槽 |
| 2.2 | `ourToolName` / `localToolActivity` 认 `no996-openfilm`；`tool_call` 优先用 ACP `toolName` | `.upstream/.../local-agent-run.ts` → `190-local-agent-run.patch` + 壳构建 |
| 2.3 | 若事件因 key/SSE/重载丢失：终态与重载策略见阶段 3 | 同上 |
| 2.4 | 思考行：保持默认收起 + 高度上限 | `patches/020-AgentActivityRow.patch` |
| 2.5 | `textCommits:0` 且工具多次失败时：结束气泡要说「本轮没有正文 / 工具失败」，不要只丢通用 503 | Host 错误文案 + 面板 |

**验收（真机）**：

1. 能触发至少一次成功工具的短轮：思考行 + **可见工具行（含 tool 名）** + 正文。  
2. 长思考轮：展开思考可滚动；折叠后仍能看到工具/正文区域。  
3. 失败轮：错误可读，且不声称「能力不可用」掩盖「模型回退」或「工具 EXTRACT_FAILED」。

**测试**：transcript/reducer 单测——交错 thought delta 与 tool_call；中断 `done ok:false` 不删已画出的 tool 行（若产品如此约定）。

---

### 阶段 3 — 中断与 SSE 终态（P1）

**目的**：区分 C1 / C2；C2 不要装成「子进程崩了」。

| 步骤 | 做什么 | 落点 |
|---|---|---|
| 3.1 | `OFFICIAL_AGENT_STREAM_LOST`：代理文案与面板文案改成「页面连接断了，请勿中途刷新；输出可能不完整」——与 `ACP_REQUEST_FAILED` 分开 | `studio-proxy.mjs` 文案表、facade |
| 3.2 | 页面重载 / 第二 ticket（`active:2`）时：尽量取消 in-flight 或保留 turn 快照，避免 Host 继续跑完再 `STREAM_LOST` 吓用户 | panel keepalive / agent cancel / 事件 hub |
| 3.3 | C1：把 ACP `-32603` 的 `data`（若有）截断进 `plugin.log`；空 data 时记 `stopReason`/最后工具码，便于下一轮修 | `acp-client.mjs` / prompt 失败路径 |
| 3.4 | 长轮：评估是否需要「工具连续 N 次同码失败 → 提前结束并说明」避免空转两分钟（产品开关，默认保守） | agent 侧或 Host 侧守卫，需单测 |

**验收**：人为刷新一次进行中的对话 → 看到的是「连接断开」类文案，不是「对话子进程出错了」。子进程真挂 → 仍是子进程文案。

---

### 阶段 4 — 工具失败收敛（P1/P2）

**目的**：去掉「转写/抽帧一失败就在思考里空转」的燃料。

| 步骤 | 做什么 | 落点 |
|---|---|---|
| 4.1 | 复现并修好 `openfilm_frame` 的 `TypeError`（阶段 0.3 的 message 会指到行） | `src/tools/frame-tool.mjs` + Studio `picture` 客户端 |
| 4.2 | `EXTRACT_FAILED`：对人可读（缺 ffmpeg、路径、编码）；同一文件短时间重复失败时工具结果明确说「不要立即重试」 | `asr-audio.mjs`、transcribe 工具描述/返回 |
| 4.3 | 对照 [`../TRANSCRIBE.md`](../TRANSCRIBE.md)：环境变量 `NO996_OPENFILM_FFMPEG` 等是否在子进程环境可见 | env 传递 / 文档 |

**验收**：坏视频 / 无音轨 → 一次失败说明原因；好视频 → 转写成功且界面有工具行。抽帧对现存时间轴项目不再 TypeError。

---

### 阶段 5 — 长轮 ACP `-32603`（P2，最后）

**目的**：在 A–D 减负之后，若 C1 仍在，再查模型 API / 上下文打满 / 子进程 OOM。

| 步骤 | 做什么 |
|---|---|
| 5.1 | 固定模型为 **已知 acp 可跑** 的 official flash，关无关工具，纯长思考是否仍 `-32603` |
| 5.2 | 若仅「多工具 + 长 reasoning」触发：限制单轮工具次数或 reasoning 上行带宽（与 ADR-0010 的 seal 流量注意一致） |
| 5.3 | 若是 API 超时/空错误：把提供方错误透传到日志（不上屏路径/密钥） |

**验收**：阶段 1–4 之后，短轮稳定；长轮失败时日志有非空原因。

---

## 5. 推荐开工顺序（给你过目用的清单）

```text
阶段 0  取证与日志（不改产品语义）
  └─ 阶段 1  模型诚实（P0）          ← 先做：否则后面真机都在测错模型
       └─ 阶段 2  思考/工具/正文可见（P0/P1）
            ├─ 阶段 3  中断文案与 SSE（P1）
            └─ 阶段 4  转写/抽帧失败（P1）
                 └─ 阶段 5  长轮 -32603（P2，按需）
```

并行建议：阶段 3 的文案拆分可与阶段 2 后半并行；阶段 4 不依赖阶段 2 的 UI 补丁，但真机「看见工具行」依赖阶段 2。

## 6. 真机剧本（每阶段共用）

环境：普通权限启动 DSH（非管理员）；插件 `0.15.22+`；日志 `%TEMP%\dsh-openfilm\plugin.log`。

1. 重载插件，确认 `host-start.startedAt` 更新。  
2. 打开问题项目，**新建对话**（不要复用已脏 Session）。  
3. 看模型菜单当前值；发「你好」。  
4. 立刻对照日志：`acp-session-model`、`acp-default-model`、`acp-model-fallback`（应与菜单一致，或阶段 1 后应有可见回退）。  
5. 再发一条带短视频的转写请求；看是否出现工具行与 `mcp-tool-failed`。  
6. 故意 F5 一次进行中的轮（仅测阶段 3）：应看到连接类错误，不是子进程类。  
7. `npm run check`；改了壳要按 ui-change 构建补丁。

## 7. 回滚

| 阶段 | 回滚 |
|---|---|
| 0 | 诊断/日志改动可留（只增可观测） |
| 1 | 恢复静默 fallback 行为；去掉面板 `fallbackReason` |
| 2 | 回退相关 `patches/*`，`shell:bake` / 官方壳构建按既有流程 |
| 3–5 | 按 PR 粒度 revert；权限与 MCP 路径不要与模型回退绑在同一提交 |

## 8. 与现有文档的关系

| 文档 | 关系 |
|---|---|
| [`incident.md`](incident.md) | 排障入口；本计划修完后应追加一条「2026-11-16」故障档案 |
| [`ADR-0010`](../decisions/ADR-0010-live-streaming.md) | 流式与 tap；阶段 2/5 改 seal/流量时必须对照 |
| [`ADR-0011`](../decisions/ADR-0011-director-contract.md) | 对话/注入契约；本计划默认不改 |
| 若阶段 1 决定「acp 永不静默 fallback」 | 另写 ADR（为什么 / 备选 / 后果），不要只改代码 |

## 9. 过目时请拍板的点

1. **阶段 1 策略**：回退时是「自动落到 official 并改菜单显示 + 提示」，还是「直接失败，逼用户选 acp 有的模型」？（推荐前者可聊、后者更硬。）  
2. **阶段 2**：中断后是否保留已出现的工具行？（推荐保留。）  
3. **阶段 4**：转写环境（ffmpeg）是否本机已确认可用？若机器本身缺 ffmpeg，4.2 只做文案不够，要先补环境。  
4. **范围**：本计划不包含「把侧栏全部模型同步进 acp」；若你要同步，标成另项，避免和 P0 缠在一起。
