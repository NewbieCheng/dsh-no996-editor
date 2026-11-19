<!-- doc
id: state
reader: 想知道"现在到哪了"的人或智能体
fact-source: package.json、docs/decisions、最近一次真机验收
checked: 0.17.14
rot-if: 每次发版、或某项从"待验"变成"验过"
-->

# 现在到哪了

> 只有这一篇写进度。别的文档不写"已实现某版本"，只写怎么用、为什么这么定。以下描述以当前工作区源码为准，不等于已发布包或用户桌面已更新；真机结果以具体验收证据为准。

- 当前版本 **0.17.14**（`package.json`，包名 `@newbiecheng/no996-editor`，小写 scope——DSH 版本检测只认小写包名），内置上游 **OpenFilm 0.4.0**（commit `715c3a6`）。安装/更新/发版见 [`playbooks/publish.md`](playbooks/publish.md)。源码仍推 GitHub。
- **GUI 更新检测（2026-11-19 实证）**：GitLab/GitHub Packages 不保存 `dsh` 元数据，DSH 的 `pnpm view name@version` 读不到 `dsh.bundle`，GUI 会显示「没有声明组合包，无法安装」。发布通道已切到 npmjs.org（保留完整 packument），诊断闸门 `node scripts/verify-registry-dsh.mjs`。

## 能用

项目与对话（Host 原生会话，**一条对话一条 DSH 会话**）、模型与思考强度菜单、审批、取消、
逐字流式回答、思考行（默认收起，最高 280px）、工具行、内联图片、归档、模板安装/检索/**模板提示词注入**、
抽帧、时间轴落盘编辑、导出、CLI 兜底（`doctor` / `version` / `skills` / `skill`）、本机口播转写、分镜（`.film/storyboard.json`）与字幕 SRT。
素材库：**全部免费素材（CC0）都能检索**——音乐/音效/贴纸走 Studio 路由，转场/特效/滤镜/文字由 Host 按库索引在进程内检索（0.4.0 收窄了 agent 动词，见 [`DEVELOPMENT.md`](DEVELOPMENT.md)）；取用走 `saved/take`，转场可自动放到切点。收费的只有生成类服务。

- **工作台切换**：剪辑、放映、画布模块经独立本地代理加载，隔离浏览器已验证切换和示例引用；桌面 GUI 待验。
- **本地视觉工具**：`openfilm_cutout` 返回透明单帧 PNG，`openfilm_face_analysis` 返回采样帧的人脸框与关键点；不识别人、不修改时间轴，绑定影片项目的 DSH 会话可用。

## 待真机验（源码完成 ≠ 可以用）

- 已发布的 0.16.1 在项目页会调用嵌入桥未实现的 `takeLink()`，导致编辑器白屏；本工作区已补齐 0.4.0 的桌面深链兼容接口（嵌入模式不接收 OS 深链），并补回「从示例开始」的翻译。修复纳入 0.16.2；隔离浏览器已验证编辑器渲染与示例引用，DSH 桌面待验。

| 项 | 怎么算验过 |
|---|---|
| 0.4.0 升级整链 | 装 0.16.3 → 整应用重启 → 侧栏「视频创作」打开、旧对话续接原 DSH 会话、同项目两个对话互不串、审批与取消有效、项目改名后历史仍在；补丁重放与壳快照一致性已由 `npm run upstream:verify`、`patches:check`、`upstream:status` 覆盖，但这些不是真机证据 |
| 会话隔离 | 同项目开两个对话各说一句，互问"刚才说了什么"：都只知道自己那条 |
| 剪辑与动效身份与注入链 | 问"你是谁/这是哪个仓库"：答 No996 Studio 的剪辑与动效搭档，不出现版本号、MIT、四层界面 |
| 原生项目 / 示例入口 | 没有项目时看到「我的项目 / 示例」窗口（不是片型卡片）；No996 模板在示例页内；「复制开工」建项目并打开；在片中点「从示例开始 → 参考」，消息里带示例引用而不是新建项目 |
| 分镜到时间轴 | 丢一段口播视频：先转写 → 出分镜 → `op=plan` 说清还缺哪个片段 |
| 免费转场整链 | 在一个真实临时项目里：搜「渐变/故障」→ 取用 → 放到相邻切点 → 抽帧看到覆盖 → 导出 MP4；锁轨/版本冲突应被拒绝并说明 |
| 表面收敛与更新提示 | 设置→服务商只留 OpenFilm/No996/本地；语音抽屉默认精选；顶栏无社区入口；升级后不自动弹更新说明，About 仍可查 |
| 拖放附件可发送 | 从资源管理器拖一段 mp4 进对话：附件 pill 为 ready（无 `describePaths` 失败）、可发送；松手后「松手即可附上」遮罩消失 |
| 技能隔离（preset 直引） | 同项目新开对话问“你有哪些 skill”：只见到 `openfilm-director/editing/motion` 3 个，无 Office/imagegen 等全局 skill；`/diagnose` 应显示影片预设的技能根及注入情况 |
| 环境查看页 | 打开插件详情页：看到「剪辑环境」区（预设状态、3 个隔离技能、11 个影片工具）；填项目 ID 能查到该片的指令链与预算 |

## 下一步

- 工作台整合见 [方案](topics/openfilm-workbench-consolidation-plan.md)：源码快照与 46 个上游补丁已重建并在干净的固定版本检出验证可应用；原快照备份在忽略目录。免费页面转场整链已跑通（`node scripts/transition-frame-check.mjs`）：官方库搜索「glitch」→ 取进临时项目 → 带版本守卫放到 3 秒切点（2.88–2.94 秒覆盖切点，2.80 秒仍是上一镜，3.20 秒已是下一镜）→ 真实导出 6.0 秒 MP4（h264_nvenc，52 KB）；素材未授权、锁轨、版本冲突、空回执和丢失回执都有拒绝路径与测试。示例引用的上游草稿编码到 Host prompt 已用固定版上游源码和 mock 桥测试；模板扩展目录的发现及复制、创建后附加记录失败的回执已测。
- 隔离壳窗口检查（`node scripts/workbench-window-check.mjs`）：无项目时直接进入原生「我的项目 / 示例」窗口，No996 模板在示例页内、没有独立片型门；「复制开工」真实建项目并在编辑器打开（时间轴 shot-01/6s、shot-02/7s）；在片中点「从示例开始」→「参考」后，发送的消息里出现 `<studio_references>` 和示例名，而不是新建项目；1120×760 窄窗无横向溢出。**仍未在当前 GUI 验收**：这些是在 `.dev` 隔离 Studio + mock Host 下用无头 Chrome 完成的。
- 两支基准片（`node scripts/benchmark-films.mjs`，证据在 `.dev/benchmarks/<时间戳>/`）：口播片 34.6 秒、1920×1080、带本机中文配音（Huihui，离线合成）；动效片 18 秒、1920×1080、带合成音垫；两条都由固定版 Studio 导出真实 MP4（h264_nvenc），ffprobe 复核时长/分辨率/音轨，口播非静音（-27.8 dB），动效片帧差由 11.77 降到 0.04（开场动效成立）。**这是无头/服务端证据**，不等于当前桌面 GUI 里手点一遍。
- 隐藏迁移：运行时表面隐藏脚本、CSS 规则、公告偏好写入和「更多技能 / 从示例开始」点击屏蔽都已删除；隐藏项改由 `NO996-UPSTREAM` 上游补丁承担。**待真机**：原 GUI 刷新后入口、语音抽屉、设置→服务商、顶栏菜单与更新提示的实际表现。
- 本机已装 **0.16.1**（registry 包，内置 OpenFilm 0.4.0；`installed-studio-probe.mjs` 在 profile 里按 Host 方式拉起 Studio 并拿到 `0.4.0` 健康响应）。pnpm 11 的安装脚本闸门：profile 的 `pnpm-workspace.yaml` 需要 `allowBuilds` 放行 `ffmpeg-static` / `protobufjs`，否则 `dsh plugin add` 退出码 1（包其实已装好），见 [发布手册](playbooks/publish.md) §5。**整应用重启后**设置→关于应显示 OpenFilm 0.4.0、兼容行同步 0.4.0。
- 本机调试安装（用户已授权，非发版）：已撤掉 `shell-ui` 扫 header SVG 的品牌注入；同版本 `file:` tgz 需 **先 remove 再 add** 才会解压新包（仅 add 会沿用旧内容）。备份见 `${profile}/package.json.bak-*`。回滚：`dsh plugin --profile desktop add @newbiecheng/no996-editor@0.15.34`。
- 本地安装踩坑并已修：首版包只拷了 `openfilm` 目录，pnpm 对 `file:` 安装会按 `package.json` 重装依赖并清掉未声明的嵌套 `node_modules`，`playwright-core` 随之丢失，Studio 起不来（日志 `studio-warm-failed STUDIO_START`，面板 503）。修法：`playwright-core@1.61.1` 声明为本包依赖、`scripts/pack-tgz.mjs` 把每个 bundled 包的依赖树嵌进自己的 `node_modules`、新增 `tests/native-dependency-declarations.test.mjs` 守住“OpenFilm 的运行时依赖必须在本包声明”。修后在 profile 里用 `scripts/installed-studio-probe.mjs` 按 Host 的方式加载 Studio 并拿到健康响应（端口 50730），证明 503 根因已除；仍需重启应用才能让运行中的进程换上修好的包。
- 尚未发版：改版本号、提交、推送、`npm publish`、tag/CI 都等用户当轮明确要求；见 [发布手册](playbooks/publish.md) 的授权边界。
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
- 检查模板提示词在新建与只读场景中的实际注入；分镜可视化另行设计。
- 不加班工作台统一 API Key（`is_default` 不可删除可轮换）+ `no996/auto` 智能路由（支持图片理解）+ DSH Web Search/Fetch + Studio 生图/配音/搜网/预留视频桥接 + 右侧工作台首页抽屉（扣费明细/可调模型费率表/默认密钥卡片）。**待真机**：登录后首句对话自动选用 `no996/auto` 并签发默认 Key；发送图片可正常识图与扣费；右侧抽屉实时展示积分明细与模型费率。

## 明确不做

预览/渲染沙箱、余额展示、技能卡、macOS/Linux 真机验收。不要把待做写成已完成。
