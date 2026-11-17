<!-- doc
id: state
reader: 想知道"现在到哪了"的人或智能体
fact-source: package.json、docs/decisions、最近一次真机验收
checked: 0.15.32
rot-if: 每次发版、或某项从"待验"变成"验过"
-->

# 现在到哪了

> 只有这一篇写进度。别的文档不写"已实现某版本"，只写怎么用、为什么这么定。以下描述以当前工作区源码为准，不等于已发布包或用户桌面已更新；真机结果以具体验收证据为准。

- 当前版本 **0.15.32**（`package.json`，包名 `@newbiecheng/dsh-openfilm`，小写 scope——DSH 版本检测只认小写包名）。安装/更新/发版见 [`playbooks/publish.md`](playbooks/publish.md)。源码仍推 GitHub。

## 能用

项目与对话（Host 原生会话，**一条对话一条 DSH 会话**）、模型与思考强度菜单、审批、取消、
逐字流式回答、思考行（默认收起，最高 280px）、工具行、内联图片、归档、模板安装/检索/**模板提示词注入**、
抽帧、时间轴落盘编辑、导出、CLI 兜底、本机口播转写、分镜（`.film/storyboard.json`）与字幕 SRT。

## 待真机验（源码完成 ≠ 可以用）

| 项 | 怎么算验过 |
|---|---|
| 会话隔离 | 同项目开两个对话各说一句，互问"刚才说了什么"：都只知道自己那条 |
| 剪辑导演身份与注入链 | 问"你是谁/这是哪个仓库"：答剪辑导演，不出现版本号、MIT、四层界面 |
| 分镜到时间轴 | 丢一段口播视频：先转写 → 出分镜 → `op=plan` 说清还缺哪个片段 |
| 拖放附件可发送 | 从资源管理器拖一段 mp4 进对话：附件 pill 为 ready（无 `describePaths` 失败）、可发送；松手后「松手即可附上」遮罩消失 |
| 技能隔离（preset 直引） | 同项目新开对话问“你有哪些 skill”：只见到 `openfilm-director/editing/motion` 3 个，无 Office/imagegen 等全局 skill；`/diagnose` 应显示影片预设的技能根及注入情况 |
| 环境查看页 | 打开插件详情页：看到「剪辑环境」区（预设状态、3 个隔离技能、11 个影片工具）；填项目 ID 能查到该片的指令链与预算 |

## 下一步

- XXX 表面收敛 + 不加班配音：0.15.25 修了 `env` 空串导致 provider 被官方 silently drop。见 已归档。**待真机**：重载后 `openfilm get list` 应见不加班已连接；配音抽屉精选有复刻+平台；Speak / `openfilm_get` tts → `assets/audio/vo`。
- 本机依赖兜底提示词：FFmpeg / 转写下载失败可「复制兜底提示词」→ 贴 DSH 主会话开完全访问；Host 按 Win/macOS+arch 填 artifact 与路径。入口：EnvironmentNotice、空态 ASR、首次向导。**待真机**：故意断网装失败 → 复制词含正确平台文件名 → 主会话装好后「重新检查」通过。
- 下载停滞切换源：FFmpeg/ffprobe 与 SenseVoice 下载无总时长上限；连接约 20s 无响应、或已开始传却 **30s 无新字节** 则中止当前源并试下一个（`src/host/download-stall.mjs`）。**待真机**：故意卡死某一源，应在约 30s 后切源并继续/报齐失败。
- 游客模式：登录门「游客进入」→ Host 内存游客会话（无 token、不打账号服务）；账号条显示「游客模式」、积分 0；「退出游客」回登录门。重载插件后游客失效。**待真机**：断网/国外打不开账号服务时仍能进工作台调试。
- 空态转写模型提示：未装本地 ASR（`/api/local-models` 无 installed）时，「AI 剪辑员工」下显示短提示；「去安装」打开设置→服务并尽量打开本地服务；可复制兜底提示词。**待真机**：无 SenseVoice/Whisper 时见提示；点开能装；装完刷新后提示消失。
- 对话中断修复：Host + 壳已 bake；另修了 RecoveryGate 假死循环（探 `/api/health`、忽略 abort）；Host `openfilm_*` 不再落到 ephemeral `working`（「正在处理」），而是可见工具行。**待真机**：重载插件后新一轮应看到转写/分镜等工具行；ticket `active` 不再每 ~9s 涨；长轮 `-32603`。「这段对话已经很长了」按 **token 用量 ≥85%** 触发，不是盯着屏幕的时间——上一轮超长思考/工具结果顶到上下文上限后就会出现，开新对话即可。
- 工作台配色 / 强调色 / DSH 全局同步已拆除（设置项、`shell-ui` 注入、iframe postMessage、`dsh-global-theme`）。品牌皮肤 `assets/theme` 仍在。
- 清配色后 20s 无 boot：品牌 logo `MutationObserver` 死循环（非 Settings About）。观察器已修；Settings About A1 已重新接回（`SettingsModal` + i18n，撤 `tuneAbout`）。**待真机**：重载后能进工作台；设置侧栏「兼容 OpenFilm」、关于「基于 OpenFilm 开发」、语言说明「不加班剪辑…」。
- 作曲栏底部上下文用量与思考强度即时同步：原生壳（`ContextUsage.tsx` + bake）在 `used === 0` 时不再渲染进度圆弧（消除 12 点方向 2px 误导黑点），`0 < share < 1%` 显示 `<1%` 与最小可见弧段；Host `syncUsage` 在 `contextPressure` 为 0/缺失时回退 `contextBreakdown`；`attach` 时补齐缺失选项并把会话已存 `agentPrefs`（含思考强度）即时同步到 Host，空白会话 `selectThinking` 通过 `store.setSelection` 持久化且 `official-facade.mjs` 优先使用稳定 `meta.sessionId`。**待真机**：打开历史对话即见真实用量或干净空环；未发消息前切换思考强度后刷新/切走再切回，菜单与实际请求仍保持新档位。
- 分镜 → 时间轴自动落地：需要 OpenFilm 的片段创建接口；在那之前 `plan` 只报 `missing`。
- 五个内置模板补 `prompt.md`；分镜可视化（Studio 只有 dist，先看能否样式注入）。
- 不加班工作台统一 API Key（`is_default` 不可删除可轮换）+ `no996/auto` 智能路由（支持图片理解）+ DSH Web Search/Fetch + Studio 生图/配音/搜网/预留视频桥接 + 右侧工作台首页抽屉（扣费明细/可调模型费率表/默认密钥卡片）。**待真机**：登录后首句对话自动选用 `no996/auto` 并签发默认 Key；发送图片可正常识图与扣费；右侧抽屉实时展示积分明细与模型费率。

## 明确不做

预览/渲染沙箱、余额展示、技能卡、macOS/Linux 真机验收。不要把待做写成已完成。
