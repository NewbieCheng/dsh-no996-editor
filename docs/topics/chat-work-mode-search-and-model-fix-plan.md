<!-- doc
id: chat-work-mode-search-and-model-fix-plan
reader: No996 工作台维护者、接手实现的 AI、桌面验收人员
fact-source: 本机 2026-11-20 诊断与 Host 日志、DSH Inspect、src/native、src/official、OpenFilm 聊天壳源码补丁
checked: 0.18.0
rot-if: 工作模式上下文、聊天桥事件、工具活动存储或模型选择契约变化
-->

# 剪辑聊天栏修复交接：模式串入气泡、思考不结束、网页搜索记录、模型档位

**交付范围：调查和实现计划。** 基线：Windows、DSH `0.2.2-rc.5`、No996 `0.18.0`（Host 启动记录和工作区版本）、仓库 `4dc838d`、OpenFilm 固定版 `0.4.0 / 715c3a6`。本次只出文档，不修改运行代码、安装配置、项目或历史会话，也没有运行模型或完成真机复验。报告里的 DSH 会话编号不能直接当作 iframe 的 `conversation`；排查时按工作台项目和对话映射到原生会话，只读取证。

## 1. 问题在哪一层

| 现象 | 结论与证据 | 应改哪层 |
|---|---|---|
| 图一：`[会话模式：智能自动…]` 出现在用户消息 | **已确认**：No996 Host 在发送前把 `promptPrefixForWorkMode()` 拼接到用户 `content[].text`，纯图片还会附加这段文字。DSH 收到的是用户正文，不是隐藏的预设上下文。不是 CSS 或 OpenFilm 编辑内核生成的。 | No996 Host＋专属 DSH 预设。OpenFilm 消息气泡无需改。 |
| 图二：回复结束后仍显示「正在思考」 | **源码有明确缺口**：补丁中 `LocalAgentTurn.stream()` 连 `seal` 也写 `pending: true`，可能在正文已经收口之后把思考行重新打开。截图没有原始帧顺序，不能断言该次必定走这条支路。 | OpenFilm 上游聊天壳源码修状态机；No996 Host 转发正确的终态和身份。 |
| 图二：网页搜索没显示或变成「已搜索文件」 | **已确认错误分类路径**：Host 转发 `toolName: 'web_search', kind: 'search'`；上游 `localToolActivity` 仅用 `/^web search/i` 识别 `search`，不匹配下划线，因而落入 `files.search`。可被折叠进工具组。截图不能独立证明这一轮实际调用了哪个工具，也不能证明历史里已保存了它。 | OpenFilm 聊天壳的工具分类、活动行及历史；Host 保证事件名、参数、关联 ID 和有限输出。 |
| 切换模型成功，却弹 `agent:select-thinking` 503 | **这次精确命中日志**：北京时间 `08:45:45.505`、`.641` 同一剪辑对话两次记录模型已切到 `dsh-opencode-free/hy4-flash-free`；`08:45:46.128` Host 收到 `medium`，而该模型只接受 `off/high`；紧随的 `.132` 是相同 trace 的 25ms HTTP 503，和用户贴出的响应一致。是**后续档位写入被拒**，不是切模型失败，也不是模型服务 503。 | OpenFilm 聊天壳停止重放无效旧档位；No996 适配层返回真实选择、保留校验、区分业务冲突和服务故障。 |

相关证据：本机 `%TEMP%/no996-editor/plugin.log` 第 218–219 行；`$DSH_HOME/no996-openfilm/logs/diagnostics-2026-11-20.jsonl` 第 1–2 行（脱敏后再转发）。模型菜单的最强嫌疑是 [ChatPane 的 attach 回写](../../patches/010-App.patch#L207-L246)：它从旧 `agentPrefs` 取 `wanted`，按旧选项循环，收到新模型选项也只比 `currentValue`，不检查 `wanted` 是否还在新列表，甚至新列表没有这项时也尝试写。另有 [即时选择函数](../../patches/220-local-agent-run.patch#L426-L452) 仅按 Agent 取最近 attach，且吞失败；切会话或快速点击时可能选错目标或让界面继续显示旧值。日志证明非法值到了 Host、切模型重复发生，**不证明**两个写入各自由哪个函数触发；首次 mock 复现用动作来源和调用计数补证。

**源码边界**：用户说的「在 OpenFilm 上游修改」，这里落实为在固定检出 `.upstream/openfilm` 的聊天壳源码中改 `apps/desktop/chat/src`，用仓库 [补丁系列](../../patches/series.json) 持久化并重新打包，不改 OpenFilm npm 安装包、不改 DSH 本体、不手改构建产物。网页搜索、思考状态和菜单界面应这样修；用户正文拼接位于 Host，必须改 Host。**不新增 DOM/CSS/HTML 运行时注入**，不靠隐藏文本或覆盖标签假装修复；实际需要送给模型的工作模式，走既有专属预设提供的模型上下文能力。已有 iframe/兼容桥不在本次拆除范围。

## 2. M1：工作模式移出用户正文（Host／预设）

1. 在 [原生 `send`](../../src/native/dsh-native-agent-service.mjs#L981-L1033) 去掉模式前缀与纯图补写；送入 `sessionController.prompt` 的文本必须是用户原文，附件和上游已有的资料引用仍走原契约，不把用户输入做正则裁剪。空消息照常拒绝，图像可合法独立提交。
2. [现有预设](../../cordis.patch.yml#L12-L24) 已挂 [静态提示段](../../src/native/openfilm-prompt.mjs#L1-L11)：长期规则（何时进入 design/produce、默认只交付预览）留在那里；将 [模式文案](../../src/native/work-mode.mjs#L53-L68) 拆成按会话读取的简短事实，如 `mode=auto; phase=design; autoExport=false`。DSH 实时 Inspect 已确认 `systemPrompt.context({ name, order, text })` 可注册动态事实；**先核对 `AssembleContext.scope` 如何关联原生会话，以及实际模型请求的呈现**，采用已公开的作用域/绑定方式，从 Host 的会话级 `readWorkMode` 读值。不能假设 `AssembleContext` 有 `sessionId`，不能用「最近打开对话」或全局当前模式兜底；若无法证实绑定，就先验证可读当前会话的 `no996_mode` 是否具备查询契约，再让预设按需读取。不要把前缀塞回正文，也不要在普通 DSH 会话注册此行为。
3. 当用户在下一轮前切模式、切自动导出、或 Agent 在自动模式里切 phase，验证后续模型步骤读取到了新值；保留导出工具现有硬校验，不拿提示词代替授权。既有会话不重写、不批量清洗；说明旧气泡中已保存的旧前缀不会因此消失，验收看升级后新消息。
4. 调整 [已有模式测试](../../tests/work-mode.test.mjs#L72-L93)（它目前反而断言前缀存在）：分别检查用户正文/复制/历史是原文、模型实际输入另有模式事实、纯图片无凭空文字、同项目 A/B 模式不同、普通预设无影响。只 mock DSH 模型和项目。

## 3. M2：思考与回合都能可靠结束（OpenFilm 源码为主）

1. [Host follow](../../src/native/dsh-native-agent-service.mjs#L519-L590) 的 DSH `assistant-stream/end` 有 `attemptId` 和 `outcome`，不是每次都有非空正文/思考；发送独立终止信号（或扩展现有帧并明确契约），包括同作用域 `turnId`、原生 turn/attempt、结果；保证没有文本也能结束，不能把累计思考当作当前 attempt 的新增量。现有 [turn/end、error、aborted](../../src/native/dsh-native-agent-service.mjs#L698-L716) 路径及 [RPC 发送后的 done](../../src/native/dsh-native-agent-service.mjs#L1028-L1065) 都纳入检查，别用「第一段正文出现」或固定计时冒充回合完成。
2. 在上游 `local-agent-run.ts`（[补丁中的 stream](../../patches/220-local-agent-run.patch#L263-L297)）与 `agent-transcript.ts`（[对应补丁](../../patches/190-agent-transcript.patch)）实现幂等收口：`delta/sync` 只更新活跃 attempt；`seal/end` 用最终快照结束当前思考，不能重新置 `pending`；正文接管按 attempt/提交身份去重，旧帧不可重开已终结的行。下一次真实 attempt 可以重新思考；整个回合 `done`/失败/取消只关本轮，并在最终保存前把历史行 `pending` 清掉、记录 `endedAt`。没有结果的工具写「未收到结果」或「已中断」，不要标成功。没有可信终态时在恢复期标「正在重连」或「状态待确认」。
3. 复用已有 `agent:turn-state` / 事件回放，不另造重连框架，不自动重发 prompt。兼容旧历史：若回合有已完成记录，只读渲染时不能把保存的旧 `pending` 当活跃状态；没有可靠终态的旧历史，默认不显示永远动画，不伪造成功或用时。已有 [重连方案](chat-state-and-reconnect-fix-plan.md#L124-L145) 写过 seal 收口，但**当前补丁仍可复核出两个 `pending: true`**；按当前源码、候选壳以及真正加载的壳三处验证，不沿用旧文档作为通过证据。
4. Mock 顺序用例：`thought → text → late seal → done`、仅工具/仅思考、空 attempt 结束、失败/取消、断线补发和重复终态、跨对话旧帧；正文不重叠、工具继续时不宣称回合结束，已经结束的回复无「正在思考」动画。

## 4. M3：网页搜索必须有可展开、可回看的记录（OpenFilm 源码为主）

1. 在 [Host 工具映射](../../src/native/dsh-event-map.mjs#L59-L68) 保留真实 `toolName`，将 `query` 或 `queries[]` 规范成用于显示的有界摘要，网页读取使用 URL；以真实 tool-call 样本和 mock 验证。结果阶段沿用 [同一个 call ID](../../src/native/dsh-native-agent-service.mjs#L598-L631)，写 `completed/failed` 和有界结果；注意现有 `rawOutput` 切到 1200 字符不等于完整 `content` 已限长，只读取活动复盘需要的摘要字段，不新增凭据、HTTP 头或原始网页正文到活动记录。不能用回答末尾的 Markdown 链接倒推工具调用。
2. 在上游 `local-agent-run.ts` 的 `localToolActivity` 里**先按规范工具名**识别 `web_search`、`web_fetch`，分别映射已有的 `research.search`、`research.read`，再进入泛用 `kind` 分支；保留空格形式兼容，`glob/grep` 仍是文件搜索。核对 [事件到 transcript 的转换](../../patches/220-local-agent-run.patch#L122-L145)、[分组](../../patches/170-agent-activity-runs.patch) 和 [活动行](../../patches/020-AgentActivityRow.patch#L87-L102)，保证「已联网搜索」明确出现在用户标出的活动区；即使折叠也能看出有联网搜索，不只显示「已搜索文件」。展开可见查询、完成/失败、可用的结果摘要与来源链接；来源仅来自工具返回的可信字段，URL 渲染限制 HTTP(S)，无结果或失败如实显示。`web_fetch` 单独标「读取网页」。
3. 验证整个 `tool_call → tool_call_update → transcript/ActRow → chat:save-turn → chat:load`：关闭活动区再打开、切走/切回、刷新后同一调用仍存在，而且每个调用只有一行。旧历史如果保留 `tool=web_search` 但写成了文件搜索，可在读取/展示时按工具名兼容转换，不重写旧记录；若历史缺失，只在能从原生会话只读事件核实并准确匹配到该回合时恢复，不能补造。最低交付要求是**新回合搜索记录持久化**，不是只在运行时闪一下。
4. Mock：同轮 `pwsh`、`grep`、两个查询的 `web_search`、`web_fetch`，成功/空结果/失败/取消/结果在回放中重复分别覆盖；搜索和文件工具各自正确，刷新后查询、状态和有限输出仍在，不重复执行查询。

## 5. M4：模型与思考强度统一回显（OpenFilm 菜单＋No996 Host）

1. 先复现 `A: medium → B: off/high`，记录作用域、动作来源（用户点击或 attach 回写）、目标模型、请求档位、允许档位和响应序号，禁止记录敏感参数。核查 [菜单即时选择和本地 prefs](../../patches/070-ModelPopover.patch#L113-L128)、[attach](../../patches/010-App.patch#L215-L246)、[页面桥](../../src/official/official-facade.mjs#L443-L475)。把菜单和 session prefs 的已应用值更新统一到同一条链；attach 以 Host 返回为准，旧偏好只用于确实尚无权威记录的恢复/初始化，且应用时必须验证当前模型最新选项。不能根据旧列表循环写入。始终使用明确的 `(projectId, conversation, agent)` 绑定；去掉按 agent 选最近会话的回退。同作用域将写操作串行，迟到的响应或切对话前的回调不能覆盖当前菜单。
2. [Host `selectModel`](../../src/native/dsh-native-agent-service.mjs#L1109-L1157) 目前忽略 DSH 返回，自己把请求或推测结果写进缓存。Inspect 确认 `sessionController.selectModel(...)` 返回 `{ selected: ModelSelection }`。用该归一结果同步 Host、存储和 UI；对还没原生会话的空白会话先按目录规范化存储，首次创建后用真实 `selected` 对账。切模型时旧档位仍支持才保留；不支持就使用该模型明确的默认或省略让 DSH 决定；没有思考选项则清除遗留值。不把列表首项当作已应用值，[`buildThinkingOption`](../../src/native/dsh-native-agent-service.mjs#L491-L515) 的首项回退需要区分「默认/未确认」与「正在使用」。读档位和写档位应使用同一模型解析逻辑。
3. 显式改档位时携带或绑定点选时的目标模型，与 Host 当前模型对账；[RPC](../../src/official/official-chat-rpc.mjs#L105-L120) 严格校验作用域及请求结构，[Host](../../src/native/dsh-native-agent-service.mjs#L1168-L1217) 拒绝旧模型或未知/未公布档位。**过时点击**或真实不支持返回可识别的业务结果，并刷新当前权威选项/回滚界面；格式错误仍拒绝，服务故障仍报错，不把任何失败改成成功。避免给可预期的档位冲突发全局 503；若采用结构化业务返回或定向 4xx，需同时覆盖 Host 路由、facade 和壳，不全局关闭错误提示。保留日志区分「模型已切」「档位没应用」。
4. Mock 回归：无效旧 `medium` 不应发出第二个请求；显式选 `off/high` 后未发消息就能回显；DSH 返回与请求不同仍以返回为准；空白/已有对话刷新、A/B 快切、同模型 id 不同 provider、无 reasoning 模型、快速选模型再选档位、故意失败回滚。验证下一次真实请求由 mock 捕获的模型和档位与菜单一致，不能只检验「没红条」。扩充 [原生桥测试](../../tests/dsh-native-agent-service.test.mjs)、[facade 测试](../../tests/facade-page.test.mjs)、[诊断路由测试](../../tests/diag-logs-route.test.mjs)，以及 OpenFilm 源码级菜单用例。

## 6. 执行顺序和交付门槛

- 先记录实机正在加载的 Host 版本和壳资源指纹，再用隔离 fixture 复现。建议 **M4 → M2+M3 → M1**：先消除有日志的切模错误；思考终态与活动持久化共享 transcript，联合验收；上下文迁移可并行，但必须满足作用域和真实模型输入检查再交付。没有证据的重复气泡可与事件/保存对账，暂不把它归到搜索或模式注入，不自动重发或删历史。
- 壳改动按 [上游补丁流程](../playbooks/upstream-bump.md#L64-L83) 在干净的固定 commit 先重放现有补丁，再改源码、产候选壳；保护现有 checkout 和快照，核对 [构建配置](../../package.json) 与补丁白名单。先 `npm run shell:dev` 验证候选；按手册产隔离正式候选并重建 manifest/补丁，不覆盖未经核对的路径。跑 `npm run upstream:verify`、`patches:check`、`upstream:status`、`npm run check:quick`，按改动补跑针对测试；改 Host 路由/源码按仓库规则执行 `docs:gen`，最后 `npm run check`。仅在另外确认的本机调试流程内安装/重启，不推送或发版。
- **真机验收必须打开当前 DSH 的「视频创作」，在测试项目而不是用户旧会话中点：** 新发「你好」只出现原文；带搜索的回合有「已联网搜索」且保存后重开还在；回答结束/取消/失败都不残留「正在思考」；从支持 `medium` 的模型切到 `off/high` 模型不再提交 `medium`、无伪 503，手选 `off/high` 即时回显且切对话/重开保持。检查窄窗暗色、控制台与脱敏诊断。只用 mock 进行自动化，不因构建或测试绿就标记真机已验。
