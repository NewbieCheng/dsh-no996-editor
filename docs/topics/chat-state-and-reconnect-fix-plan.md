<!-- doc
id: chat-state-and-reconnect-fix-plan
reader: No996 工作台维护者、桌面验收人员
fact-source: 本机 diagnostics JSONL、plugin.log、sessionController Inspect、src/native、src/official、OpenFilm 壳补丁
checked: 0.18.0
rot-if: 原生回合事件、聊天桥重连机制或项目身份校验发生变化
-->

# No996 对话状态与自动重连：调查及修复方案

**范围：** 截图所示的视频创作工作台聊天栏。调查基线为 Windows 桌面、DSH `0.2.2-rc.5`、No996 `0.17.15`。本文只交付调查与方案，不修改产品代码、安装配置或既有项目和会话。

## 1. 结论

- **两次周期性中断最可能是桌面本地凭据固定 30 分钟到期，恢复闸门随后重载 iframe。** 新核对的四段间隔均为 `30 分钟 + 5.16–5.36 秒`（跨插件 `0.17.11` 和 `0.17.15`）。这与凭据期限和 5 秒一轮、连续两次失败触发恢复的代码吻合；当时缺少逐请求认证判因，尚不能逐次证明哪个请求先失败。不是两次模型退出：两轮均在重载后由原 Host 回合正常结束。
- **全屏按钮的报错已直接定位。** 此按钮调用 `requestFullscreen()`；跨源 Studio iframe 只委派了剪贴板能力，没有委派全屏，而调用方没处理拒绝，所以按钮无效并出现全局红条。这与凭据到期是两个问题。
- **已确认客户端会把短暂断流当成这轮对话失败。** `EventSource.onerror` 直接关闭连接并拒绝已发出的请求；服务端虽然发了重连提示，但发送的事件没有补发能力。日志也确实记录到：同一轮进行中，页面重新加载并接回原对话，随后 Host 正常结束，期间没有第二次 `native-prompt-start`。这不能解释每次断流为何发生，但足以解释为什么刷新后又有结果，以及为什么不应自动重发请求。
- **已找到“答完还在思考”的代码缺口。** 思考 `seal`（流结束时的最终内容帧）被 UI 当成一次普通更新，仍写成 `pending: true`。现有关闭逻辑依赖后续正文或工具事件；如果没有后续正文、帧乱序或页面漏收，就存在保持或重新打开「正在思考」的路径。截图没有这部分的帧序列，不能把其中某一路径定为该次故障的唯一根因。
- **截图的 503 是聊天历史保存被身份校验拦住，不是模型返回 503。** 这条先单独处理，不能通过放开校验或吞掉错误让红条消失。

## 2. 现场日志与证据

本次实际读取的入口：

- 诊断中心落盘：`$DSH_HOME/no996-openfilm/logs/diagnostics-YYYY-MM-DD.jsonl`，本机 `$DSH_HOME` 为 `C:\Users\Administrator\.dsh`。核对了 11 月 18、19 日两份。
- 插件日志：`%TEMP%/no996-editor/plugin.log`，本机实际文件位于 `C:\Users\Administrator\AppData\Local\Temp\no996-editor\plugin.log`。该文件当前从 11 月 19 日开始，不能用它反推截图当天的 Host 行为。
- `%TEMP%/no996-editor-host.json` 记录运行版本和启动时间。后续复现可联合工作台诊断中心及 `/api/no996-openfilm/diagnose` 的回合计数；`%TEMP%/no996-editor-frames.jsonl` 是单轮覆盖的原始帧入口，不是历史日志。导出前要脱敏。

以下时间均为北京时间（UTC+8）：

| 时间 | 观察 | 能说明什么 |
| --- | --- | --- |
| 11 月 18 日 21:21:26 | 诊断文件第 1–3 行与截图匹配：`chat:save-turn` 在 42ms 内返回 `OFFICIAL_CHAT_PATH_CHANGED` / HTTP 503；`/api/health` 在约 4s 后被中止；`/kept` 约 4s 超时。 | 三个独立请求在同一时段报错，没有共同回合 ID。健康探针取消和 `/kept` 超时均不能单独证明 Studio 或模型退出。 |
| 11 月 18 日 21:36:11、21:37:15 | 另有 `Disallowed by permissions policy`。 | 与红框错开至少 14 分钟；没有证据表明与该次断流有关，也不应为此放宽 iframe 权限。 |
| 11 月 18 日 21:58:32、11 月 19 日 09:30:31 | 多个项目的 SSE 日志分别在毫秒级时间内聚集，`readyState=2`（关闭）。 | 确有连接关闭记录，但未记录关流发起方、HTTP 握手状态或 iframe 生命周期原因，无法区分导航、认证、代理、Host 或其他原因。 |
| 11 月 19 日 21:44:57 → 21:57:25 | 插件日志第 77–87 行：原生回合开始；21:52:24 页面重新 bootstrap / boot，随后 attach 原对话；原回合正常 `end_turn`，38 次文本提交。 | 本次页面重新加载没有终止 Host 回合。没有证据区分是用户刷新还是程序触发。 |
| 11 月 19 日 22:21:01 → 22:28:11 | 插件日志第 95–105 行：使用另一模型的原生轮次中，22:22:29 再次 bootstrap，随后重挂同一对话；原回合正常 `end_turn`，3 次文本提交。 | 同种现象不只出现在一个模型上。现有资料不能确定所有中断原因；两天结构化日志没有 `NATIVE_TURN_ERROR` / `NATIVE_FOLLOW_ERROR` / `API_SESSION_ERROR` 记录，缺记录不代表从未发生。 |

### 2.1 两次中断为什么会发生：30 分钟到期是首要原因

重新按 `ticket-redeemed`（兑换本机代理会话凭据的时刻）对齐 [插件日志:15–108](<C:/Users/Administrator/AppData/Local/Temp/no996-editor/plugin.log#L15-L108>)：

| 起始凭据兑换 → 下次兑换（北京时间） | 间隔 | 当时发生了什么 |
| --- | ---: | --- |
| 17:45:34.073 → 18:15:39.269 | 30:05.196 | 旧版 `0.17.11` 也出现同样周期；未证明是活跃轮次断流。 |
| 21:22:19.546 → 21:52:24.782 | 30:05.236 | 第一次：当轮继续运行，21:57:25 原回合结束。 |
| 21:52:24.782 → 22:22:29.942 | 30:05.160 | 第二次：当轮继续运行，22:28:11 原回合结束。 |
| 22:22:29.942 → 22:52:35.300 | 30:05.358 | 再次出现周期性重挂，不在已记录的活跃回合内。 |

每次兑换后的 `active` 都是 1，两次 bootstrap 返回 200，仅用 4ms 和 1ms；期间没有新 `host-start`。另查了桌面 crash 日志目录与两次重载前后约 80 秒的 Windows 应用错误和电源事件，没有找到对应记录。没有证据表明这两次是 Host 重启、系统休眠或模型主动断开。

可解释该周期的代码链：

1. [代理凭据](../../src/studio/studio-proxy.mjs#L94-L114) 固定 30 分钟，Cookie 同样 [30 分钟有效](../../src/studio/studio-proxy.mjs#L147-L159)，没有就地续期；过期后新的 [/api/health 和其他代理请求](../../src/studio/studio-proxy.mjs#L309-L325) 与 [SSE 握手](../../src/studio/studio-proxy.mjs#L805-L820) 会被拒绝。已有 SSE 并不必然当场断掉；Studio WebSocket 则有 [30 秒鉴权复检](../../src/studio/studio-proxy.mjs#L920-L948)，过期后也会关。两者不是同一条流。
2. [iframe RecoveryGate](../../patches/260-RecoveryGate.patch#L29-L66) 每 5 秒探健康，两次失败就发 `restart`；[外层面板](../../src/studio/studio-panel.mjs#L100-L104) 重新进入 loading，[restart 消息](../../src/studio/studio-panel.mjs#L162-L182) 会增加 `attempt`，使现有 iframe 被替换，聊天订阅随之消失。外层另有 [HTTP 页面专用轮询](../../src/studio/studio-panel.mjs#L231-L268)，它不运行在截图的桌面自定义协议面板，不能归为此次桌面触发器。
3. **缺少最后一跳证据：** 普通 health 请求拒绝主要走通用响应，报错上传 [本身也要求同一有效凭据](../../src/studio/studio-proxy.mjs#L585-L593)，所以到期时 UI 日志可能正好传不出去。用代理端分支日志和加速时钟复现补证；不把其他离散 SSE 错误、`/kept` 超时或 11 月 18 日的存储 503 一并归为凭据到期。

### 2.2 全屏红条的独立根因

[11 月 19 日诊断:14–15](<C:/Users/Administrator/.dsh/no996-openfilm/logs/diagnostics-2026-11-19.jsonl#L14-L15>) 为北京时间 21:52:43.671、23:01:37.596，同一堆栈。逐列定位 当时的打包文件 `workbench-edit-CHgnlOLk.js`（已被后续构建替换）：`130:14077` 是 `preview-fullscreen` 的 `onClick`，`146:69857` 是 `requestFullscreen()` 调用，Promise 没有被处理。[Studio iframe](../../src/studio/studio-panel.mjs#L316-L334) 跨源嵌入，只声明 `clipboard-read; clipboard-write`。11 月 18 日旧壳保留的同签名堆栈也对应 `requestFullscreen()`；这是预览按钮错误，不是网络错误，也与 21:52:24 那次重载不是同一事件（报错晚约 19 秒）。

## 3. 修复顺序

### P0-0：消除定时重载，桌面凭据在原 iframe 内更新

- 由已认证的 DSH 外层在到期前触发受控续期，复用一次性短时票据与编辑器源的 Cookie 兑换能力；使已加载的 iframe 就地获得新的短期 Cookie，不改 `src`、不重挂 iframe。设计阶段验证桌面自定义协议与分区 Cookie 的实际行为；保留 Host/Origin/source/项目归属校验，不使用公开续期入口或永久凭据。票据不进日志、URL 查询或持久存储；若用 `postMessage`，双向验证对端及当前 iframe，并明确指定目标来源。
- 续期单飞，处理窗口挂起/唤醒导致错过续期。旧 WebSocket 的连接请求仍带旧 Cookie，不能假设 Set-Cookie 会替换既有握手头：在有效期内受控交接，或在凭据换代后有序重连受影响的 WebSocket/SSE 并对账；不得跳过现有鉴权复检。需要续期的读/订阅可恢复，对于已提交的写入先核对结果，不自动重发。
- 区分「凭据过期」「Studio 不可达」「调用主动取消」。凭据失效先恢复认证，线路短断只恢复对应流；只有明确证实 iframe/服务无法恢复才考虑整页重挂，且优先保护未保存编辑、播放头和输入草稿。代理记录认证拒绝原因及凭据年龄区间；闸门记录触发来源和恢复结果，即使 iframe 无法上传诊断也能定位。测试时先缩短 TTL 复现原现象，再验证修复跨多个续期周期。

### P0-A：把“思考结束”“回合结束”“任务做完”分开

证据：Host 在 [原生会话桥](../../src/native/dsh-native-agent-service.mjs#L498-L570) 发 `seal`，初始 `snapshot` 只同步用量，未消费历史记录和 `assistantStream.activeAttempt`；[流式 UI](../../patches/220-local-agent-run.patch#L258-L291) 对 `seal` 仍设置 `pending: true`，[transcript reducer](../../patches/190-agent-transcript.patch#L22-L44) 依赖后续非思考事件关掉该行。另有 [120ms 的 status 兜底](../../src/native/dsh-native-agent-service.mjs#L156-L169) 可能早于持久结束帧，不应把“暂时空闲”一律视作成功。

1. Host 转发明确的 attempt 结束及回合终态；前端按「项目 + 对话 + 回合 + attempt」对账。`seal` 更新最终内容并结束该 attempt 的思考态，不允许同一 attempt 的迟到增量重新打开。下一次真正开始思考才允许重新显示，保持每轮一条可展开的思考摘要。只发工具、不发正文、取消、失败都必须收口。
2. 回合终态以原生 `turn/end` / `turn/error` / `turn/aborted` 和已核实的会话记录为准。`running=false` 触发查证，不直接合成成功；核不到结果就显示「状态待确认」。收到终态后一次性关闭该回合所有临时加载态；没有结果的工具标「已中断」或「未收到结果」，不能冒充成功。
3. 把任务状态与本轮回执分开。有明确计划仍有未完成项时，闲置的回合显示「本轮结束 · 还有 N 项待完成」，提供继续入口；没有可靠任务清单时只写「本轮回复已结束」，不推断任务已做完。若后续计划轮已在运行，显示「正在继续 · …」，不提示用户重发。

### P0-B：自动接回原回合，不要求刷新，不重做动作

证据：[客户端门面](../../src/official/official-facade.mjs#L151-L205) 首次握手后仍在每次 `onerror` 关闭源、拒绝已发回合；[SSE 传输](../../src/official/official-event-stream.mjs#L67-L107) 有背压队列、心跳与重连提示，但无事件游标和历史补发。[原生 follow](../../src/native/dsh-native-agent-service.mjs#L705-L742) 结束后清掉订阅，异常路径会直接结算当前轮，没有独立的状态核对过程。

1. **同页短断线**：先后台恢复，超出短断提示阈值才标记「正在重新连接」，保留已显示内容和已提交回合身份；为当前作用域仅保留一条有效订阅，带退避与抖动重连。重连后先用原回合/请求 ID 对账，再退出恢复提示；不发第二次 `agent:prompt`，不自动取消，也不新建会话。等待超过自动恢复预算时显示「暂未确认任务状态」和「重新连接」，不显示「已完成」。
2. **漏帧或整页刷新**：给桥增加同一会话范围内可排序的事件标识与有限补发窗口，按最后已应用游标幂等补齐，不能用连接实例是否相等过滤新连接的终态。窗口过期、Host 换代或刷新丢失暂存时，走 Host 权威快照：稳定映射到原 `sessionId`，用已核实的 DSH `state`、`events` 和 `follow` opening snapshot 对齐现有正文、工具和终态，再接增量。实时 Inspect 显示 `events` 支持序列分页，`follow` 返回 `cursor` / `records` / `assistantStream`；当前 `SessionFollowRequest` **未声明 resume cursor 字段**，不假定可以传 `afterSeq` 给 `follow`。快照与实时交接用序列去重、防缺口；未提交的流式碎片允许由权威快照替换，不承诺逐字符重放。
3. **分层恢复**：只断聊天 SSE → 重连聊天；只有确认 Studio 不可达才尝试外层 bootstrap。区分探针自身超时、切页/卸载主动取消以及非 2xx，避免把普通取消当故障，也避免现在 [RecoveryGate](../../patches/260-RecoveryGate.patch#L41-L60) 忽略所有 `AbortSignal` 中止、连真超时也不计数。外层重建需记录触发来源；不得用无限刷新循环恢复。Host 真正重启后，若原轮已无法继续，显示真实状态和恢复出的持久历史，不自动重跑工具。
4. **补足定位日志**：串联连接 ID、脱敏会话标识、回合与请求 ID、最近序号、连接/健康状态和生命周期来源。至少记录 SSE 打开/关闭、HTTP 握手失败、队列溢出、iframe 刷新来源、原生 follow 结束原因、回合终态、恢复补发数量及延迟。用同一轮的时间线区分「没生成」「生成了没转发」「转发了没应用」「生成了但保存失败」，不记录命令正文、模型内容、凭据或未脱敏路径。

### P0-C：恢复预览全屏，受限时就地放大

1. 仅对 [通过校验的 Studio iframe](../../src/studio/studio-panel.mjs#L121-L131) 委派 `fullscreen`（接入层用限定的 iframe `allow`，若有父级禁用策略则不能靠子 iframe 覆盖）。不改 DSH 全局权限，不放开其他 iframe、来源或能力。
2. OpenFilm 预览按钮在原点击手势内调用 `requestFullscreen()`，处理请求和退出的拒绝；用 `fullscreenchange` 同步图标。若宿主不支持或策略仍禁止，则切到工作台内容区内的沉浸预览，保留画面比例、播放头和原播放器状态；`Esc` 或退出按钮可返回原布局，恢复焦点。两条路径都不导航、不重挂 iframe、不影响聊天连接。
3. 处理后的可预期拒绝不再触发全局红条；需要提示时在预览旁简短说明「此环境不支持系统全屏，已切换为窗口内放大」。仅在意外失败时记录脱敏原因。通过上游补丁流程修改预览源码，不改打包文件。

### P1：让工作台聊天栏的执行状态始终看得见

- **默认折叠命令详情，不折叠执行态。** 卡片头始终显示 `DSH · 执行命令`（或工具名）、脱敏摘要、状态和运行时长；展开后看命令、允许展示的参数、有限长度的结果或错误、已提供时显示退出码。用可键盘操作的展开按钮；不因为增量或重连重置当前展开状态，不把完整工具输出无清理地写入诊断或历史。
- **运行中不只靠正文或思考动画。** 在输入框上方固定显示「正在执行 2 个工具」「等待审批」「排队中」「连接恢复中 · 上次状态：正在执行」等，滚动到旧消息时仍可见；已给出一句正文但原生还在运行，不显示「已完成」。完成/失败/取消要有文字，不只靠颜色或转圈。切换对话不混入其他对话的工具；未知工具仍给通用可见卡片。
- **改动落点**：[Host 工具映射](../../src/native/dsh-event-map.mjs#L17-L77) 与对应回合事件传输；OpenFilm 聊天壳的 [运行态映射](../../patches/220-local-agent-run.patch#L117-L137)、[消息状态](../../patches/190-agent-transcript.patch) 和 [活动行](../../patches/020-AgentActivityRow.patch#L87-L123)。当前实机 `shell.overlay` 中已有 `no996-openfilm-panel`；这次增强 iframe 内聊天，不替换 DSH 主会话界面，不改 DSH 本体或手改压缩产物。桌面验收时确认用户指的聊天栏布局；仓库默认是右侧，改动不绑死在左/右位置。

### 并行排查：保护历史，单独解决 `OFFICIAL_CHAT_PATH_CHANGED`

[聊天存储](../../src/official/official-chat-store.mjs#L14-L35) 会核对当前与已保存目录、`.film/id` 及文件系统证据，[读记录](../../src/official/official-chat-store.mjs#L118-L136) 无法确认同一项目时拒绝。截图只能证明该分支发生，不能判定是改名、同 ID 副本、路径拼写差异还是当时文件不可访问。

- 先补可安全记录的分支原因：是否为同一目录的路径别名、标记是否失效、旧目录仍存在、读取失败等，不在日志暴露实际路径。用临时目录覆盖同一物理目录不同拼写、受控重命名、两个目录同 ID、目录不可读。
- 仅在 Host 能证明同一物理项目、或有可信的受控重命名记录时恢复绑定。无法证明则不覆盖旧历史；保留本轮可见输出或从原生回合恢复，在聊天内提示「回复已结束，历史暂未保存」，将保存失败与模型/网络错误分开。对不确定写入先查版本和稳定 `turnId`，不盲重试；重连后不得因历史写入失败而再次执行 Agent。

## 4. 实施与验收

先复现固定周期并做 P0-0（就地续期），A/B（可靠终态与断线补齐）联验，C（全屏）可独立做，随后加 P1 和单独的历史保存修复。沿用 [上游补丁流程](../playbooks/upstream-bump.md) 生成壳产物；测试只用 mock、临时项目和临时存储，不调用真实模型、不触碰既有项目。

**无感恢复验收目标：** 凭据正常轮换不显示提示、不重载页面；成功在 2 秒内对账的短断不弹错、不打断输入，超过 2 秒只在聊天内显示「正在重新连接」。在本机 mock 故障注入中，依赖恢复可用后 5 秒内恢复流并对账原回合；持续不可用才提示用户，仍保留已有输出。这是验收目标，不是当前实测或对 Host 真正停机的保证。统计自动续期成功率、非用户触发的 iframe 重载次数，以及断线到状态对齐耗时，区分正常切页关闭，不以「没红条」代替恢复成功。

| 验收用例 | 通过标准 |
| --- | --- |
| 短 TTL 故障注入；有正在执行的命令、输入草稿与未保存编辑；至少三次续期，并做一次唤醒穿越到期 | 正常续期零 iframe 重载、零重复命令；错过续期自动接回原会话；验证播放头、草稿和编辑不丢。续期失败或来源不符时仍拒绝越权。 |
| 点击截图的预览全屏，进入/退出；强制禁用全屏，再点一次 | 可原生全屏且 `Esc` 退出；禁用时就地放大，无 `unhandledrejection`、无诊断红条、无页面重挂、聊天不中断。 |
| 一句回复；仅思考/仅工具；迟到的 `seal` 或旧 attempt | 阶段结束不再显示「正在思考」；终态后迟到帧不能重开；正文无重复。 |
| 执行两个工具、一个失败；回复已出现但任务还在运行；有明确未完成计划 | 命令默认折叠可展开，进行态始终可见；工具结果各自正确；本轮结束不冒充计划做完。 |
| mock SSE 在正文中、工具中、终态前分别断开；浏览器刷新、切 A/B 对话 | Host 不重复收到 prompt，原命令不重跑；断开时可见恢复态，网络恢复后同一会话自动补齐正文、工具和终态，不串对话。自动恢复失效时有明确状态和重连入口。 |
| 暂时 `/health` 超时、主动取消、SSE 队列溢出、Host 重启 | 主动取消不误报；单一探针失败不重载；缓冲溢出或 Host 换代走对账；无法继续的回合不冒充成功。 |
| 重命名／同 ID 副本／`chat:save-turn` 失败 | 有证据的同一项目可保持历史；可疑副本不继承、不覆盖；保存失败明确说明且不重复执行。 |

优先扩充 [native service 测试](../../tests/dsh-native-agent-service.test.mjs)、[facade 事件测试](../../tests/official-facade-events.test.mjs)、[SSE 测试](../../tests/official-event-stream.test.mjs)、[聊天存储测试](../../tests/official-chat-store-delete.test.mjs)。目前 facade 明确测试「断流直接失败」，后续应改为覆盖「先恢复、可证实终态才结算」。最后用 Windows DSH 桌面与 mock 测试项目复核上述交互（含窄窗、暗色、切对话）；本次没改代码，也没有进行故障注入或真机修复验收。

## 5. 实施记录（本轮）

代码已按上面的顺序落地，快照与补丁系列同步重建；**真机点击验收由人完成**，自动化只覆盖到 mock、临时目录与真实代理进程。

### P0-0 静默续期

- [代理](../../src/studio/studio-proxy.mjs)：续期**复用同一 Cookie 值**，只延长有效期并重设 `Max-Age`。换新值会让已建立的 WebSocket 握手头里那个旧值失效，而代理的每 30 秒鉴权复检正是读那个头。首次兑换仍发新值。
- 新增 `POST /api/no996-openfilm/renew-session`（[bootstrap.mjs](../../src/studio/studio-controller/routes/bootstrap.mjs)）：只对桌面自定义协议签发一次性票据，沿用 DSH 自身的 Host/Origin/浏览器 peer 校验；浏览器模式没有代理自有凭据，返回 204。
- 面板（[studio-panel.mjs](../../src/studio/studio-panel.mjs)）按 `sessionExpiresIn` 在到期前（五分之一寿命，最多 5 分钟）向 iframe 发 `no996-openfilm:renew-session`，iframe 内注入脚本就地兑换并回执；成功按新寿命重排，失败短退避重试，**不重挂 iframe**。窗口唤醒时若已过点，立即续期。
- 测试：`tests/session-renewal.test.mjs`（同一 token 延长、跨原到期时刻仍可认证、单次票据、无活会话时换新、浏览器模式不签发、寿命边界）、`tests/panel-session-renewal.test.mjs`（到期前发消息、不重建 iframe、失败重试）。

### P0-A 思考 / 回合 / 任务

- 上游 `LocalAgentTurn.stream()`：`seal` 直接把该行置为结束并记 `endedAt`；`sync` 仍保持进行中。这样答案写完、思考结束就不再等下一帧来收口。
- Host（[dsh-native-agent-service.mjs](../../src/native/dsh-native-agent-service.mjs)）在 `turn/end`、`turn/error`、`turn/aborted` 前补发一次思考收口帧，取消或流中断也不会留下「还在思考」。
- `settleTurn` 记录本回合结局（`lastSettled`），配合 `agent:turn-state` 只读查询，供断线后的页面核对。

### P0-B 断线自动接回

- [事件中心](../../src/official/official-event-hub.mjs) 给每帧编号并保留**有界**回放尾巴（400 帧 / 1 MB / 32 个项目），编号从 1 起；[SSE 传输](../../src/official/official-event-stream.mjs) 接受 `afterSeq` 先补发再接实时；[代理路由](../../src/studio/studio-proxy.mjs) 只多允许这一个参数，其余查询串仍拒绝。
- [客户端门面](../../src/official/official-facade.mjs)：有回合在跑时断流不再立即失败，而是按退避重连并带 `afterSeq`；重连就绪后用 `agent:turn-state` 对账，Host 说已结束就按真实结局收口。**不重发 `agent:prompt`**。空闲页面断流仍直接丢弃，不占连接。恢复预算内没回来才报「stream disconnected」。
- 测试：`tests/official-event-stream.test.mjs` 增补「按游标补发、不重复、尾巴有界」；`tests/official-facade-events.test.mjs` 把旧的「断流立即失败」改为「短暂断开续上同一回合」「预算耗尽才失败」「离开期间结束的回合与 Host 对账」。

### P0-C 预览全屏

- 面板 iframe 增加 `allowFullScreen` 与 `allow="clipboard-read; clipboard-write; fullscreen"`，只委派给通过校验的那个 Studio 来源。
- 注入脚本（[studio-proxy.mjs](../../src/studio/studio-proxy.mjs)）保留原生全屏路径；只有浏览器拒绝时才把该元素就地铺满窗口，`Esc` 退出，并以 `info` 级别记一条 `FULLSCREEN_FALLBACK`，**不再弹全局红条**。
- 测试：`tests/editor-fullscreen.test.mjs` 在最小 DOM 里跑注入脚本，覆盖拒绝兜底、原生路径不受影响、`Esc` 退出。

### P1 命令卡片与运行态

- 工具行新增「详情」：默认收起，展开显示命令/路径与截断后的输出（[AgentActivityRow.tsx](../../patches/020-AgentActivityRow.patch)）；数据来自 `rawInput` / `rawOutput`，不新增敏感字段。
- 状态行改为按数量说话：「正在执行 N 个工具」，不再只写「思考中」。
- 词条新增 `act.details`、`act.running`（五个语言包）。

### 历史保存

- [聊天存储](../../src/official/official-chat-store.mjs)：身份核对改为返回**原因码**（缺标记、标记不符、旧目录仍在、不可读、非同一目录），随错误 `diag` 上报；同一物理目录除 inode 外增加 `realpath` 比较，Windows 报 0 inode 或路径拼写不同也能认回。无法证明时仍然拒绝覆盖。

### 构建与快照

- 上游检出切到清单固定的 `715c3a6`（原工作区停在 0.3.2），补丁在干净检出上重放通过；`vendor/official-shell` 由该检出重建，旧快照备份为 `vendor/official-shell-backup-20261119-235110`；随后 `shell:bake` 重新烘焙主题，`patches:split` 重生成 58 个补丁，`upstream:status` 无问题。
- 另修了 [scripts/upstream.mjs](../../scripts/upstream.mjs) 的一个真实缺陷：构建命令用 `stdio: 'inherit'` 时 `execFileSync` 返回 `null`，旧代码对 `null` 调 `.toString()`，导致每次 `shell:dev` 在构建成功后崩掉、新产物从未复制到 `.dev/shell`。

### 仍未做

- 计划里「本轮结束 · 还有 N 项待完成」的提示需要把计划条目与本轮回执关联，属独立改动。
- 常驻（滚动也不消失）的运行横幅仍靠输入框上方的既有状态，没有新增吸附层。
- [RecoveryGate](../../patches/260-RecoveryGate.patch) 仍忽略所有 `AbortSignal` 中止，真超时不计入失败；凭据续期消除了主要触发源，但探针口径尚未改。
- 真机验收：在桌面 GUI 里连续跨过两次续期、断网重连一次、点一次预览全屏、发一条带命令的请求，确认无重载、无红条、思考行收口。
