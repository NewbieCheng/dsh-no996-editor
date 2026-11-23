<!-- doc
id: state
reader: 想知道"现在到哪了"的人或智能体
fact-source: package.json、docs/decisions、最近一次真机验收
checked: 0.21.21
rot-if: 每次发版、或某项从"待验"变成"验过"
-->

# 现在到哪了

> 只有这一篇写进度。别的文档不写"已实现某版本"，只写怎么用、为什么这么定。以下描述以当前工作区源码为准，不等于已发布包或用户桌面已更新；真机结果以具体验收证据为准。

- 当前版本 **0.21.21**（`package.json`，包名 `@newbiecheng/dsh-no996-editor`，小写 scope——DSH 版本检测只认小写包名；配套视觉权重包 `@newbiecheng/no996-models-vision@0.2.0`），内置上游 **OpenFilm 0.4.0**（commit `715c3a6`）。安装/更新/发版见 [`playbooks/publish.md`](playbooks/publish.md)。源码仍推 GitHub。
- **GUI 更新检测（2026-11-19 实证）**：GitLab/GitHub Packages 不保存 `dsh` 元数据，DSH 的 `pnpm view name@version` 读不到 `dsh.bundle`，GUI 会显示「没有声明组合包，无法安装」。发布通道已切到 npmjs.org（保留完整 packument），诊断闸门 `node scripts/verify-registry-dsh.mjs`。

## 能用

项目与对话（Host 原生会话，**一条对话一条 DSH 会话**）、模型与思考强度菜单、审批、取消、
逐字流式回答、思考行（默认收起，最高 280px）、工具行、内联图片、归档、模板安装/检索/**模板说明按需读取**、
抽帧、时间轴落盘编辑、导出、CLI 兜底（`doctor` / `version` / `skills` / `skill`）、本机口播转写、分镜（`.film/storyboard.json`）与字幕 SRT。
素材库：**全部免费素材（CC0）都能检索**——音乐/音效/贴纸走 Studio 路由，转场/特效/滤镜/文字由 Host 按库索引在进程内检索（0.4.0 收窄了 agent 动词，见 [`DEVELOPMENT.md`](DEVELOPMENT.md)）；取用走 `saved/take`，转场可自动放到切点。收费的只有生成类服务。

- **工作台切换**：剪辑、放映、画布模块经独立本地代理加载，隔离浏览器已验证切换和示例引用；桌面 GUI 待验。
- **本地视觉工具**：`openfilm_cutout` 返回透明单帧 PNG，`openfilm_face_analysis` 返回采样帧的人脸框与关键点；不识别人、不修改时间轴，绑定影片项目的 DSH 会话可用。

## 待真机验（源码完成 ≠ 可以用）

- **2026-11-23 13:1x 浅色/深色跟随 + 官方图标 + 去开发中（0.21.21，源码完成，待重建 + 真机验）**：
  1. **切换器下拉框跟主题**：`sidebar-editing.mjs` 里菜单/弹窗/提示条/视图选项弹层把背景写死为 `var(--bg-elevated, #232325)`——宿主 token 表里没有这个名字，于是永远回退深色，浅色主题下仍是黑面板。改为 `var(--dsw-alias-bg-overlay, …)`，边框改 `var(--dsw-alias-border-l1, …)`；错误色 `${'#e07b5a'}` 改走 `--dsw-alias-state-error-primary`。回归测试 `sidebar-editing-rows.test.mjs` 新增用例锁死禁止再用那两个不存在的变量名。**已真机确认问题**（用户截图：浅色主题下「工作区/剪辑区/整理剪辑历史」浮层是黑底）。
  2. **设置左栏图标改官方 App 图标**：原来 `SettingsNavIcon` 用白环裸字形 + 猜 `data-theme` 上色，猜错即隐形、16px 下发虚。改为 esbuild `loader: {'.svg': 'text'}` 内联 `icon.svg`（深蓝圆角底＋白字形＋橙箭头），自带不透明底→深浅主题一致，无主题嗅探。**待真机验**：切换浅色/深色，设置左栏图标都清晰可辨。
  3. **删「（开发中）」**：`locale/zh.json`、`locale/en.json` 描述去掉开发中字样；`tests/settings-section.test.mjs` 新增用例禁止用户可见文案再出现开发中/In development/beta。
  - 上一版（0.21.20）的设置页唯一界面**已真机确认**：设置左栏「不加班工作台」行出现、新卡片页可打开、登录弹窗正常（用户截图）。

- **2026-11-23 10:1x 听写采集挪进 DSH 主框架 + 绑定对话回归工作区列表（0.21.12，源码/壳快照/client 完成，待重启真机验）**：
  1. **听写**：读 DSH 安装包确认桌面麦克风策略只授主窗口主框架（`isMainFrame` + `dsh-app://app` + audio），子框架无条件拒绝且永不弹窗——此前 `micDenied` 的根因，Windows 隐私设置页配置无效（桌面应用走总开关，不逐应用列条目）。修法：工作台点麦克风 → 外层 DSH 页面代录（[frame-capture.mjs](../src/studio/frame-capture.mjs)，16 kHz 单声道 WAV、120 s 上限自动收尾、录音不落盘不进日志）→ 经校验消息桥交回工作台帧 → 仍走工作台自己的 ASR（与 DSH 听写模型/开关互不相干）。主框架代录不可用时回退帧内自采；拒绝原因按原五类映射并照常上报 `dictation-mic-failed`。测试：`tests/frame-capture.test.mjs`（6 例：WAV 头/采样率/时长/RMS、拒绝原因、上限自动收尾、垃圾 id、麦克风释放）、`tests/panel-capture-bridge.test.mjs`（接线 + 外来来源拒绝）。**待验**：完整重启后在工作台点麦克风直接可用（桌面端自动放行，无需任何设置）。
  2. **会话**：剪辑区绑定的对话不再从工作区列表隐藏（移除 `hiddenSessionIds` 机制），工作区行与剪辑区行打开同一条 DSH 会话，不再诱导复制会话导致历史分叉。测试：既有 editing 路由用例回归；ARCHITECTURE §2.1 已更新。**待验**：影片项目的对话出现在工作区列表且点开即完整历史，左右操作互相同步。
- **2026-11-23 03:1x 听写提示关闭按钮归位（0.21.11，源码 + 壳快照完成，待重启真机验）**：中文麦克风提示等长文案下，提示条用 `flex flex-wrap ... justify-between`，文案占满一行后把动作组（`×`）挤到下一行左端，与上方 turn 错误卡片的右侧 `×` 不一致。改法：上游 `apps/desktop/chat/src/App.tsx` 的 `dictationNotice` 文案 span 改 `min-w-0 flex-1 break-words`、动作组 `shrink-0`，去掉 `flex-wrap`，`×` 固定在右侧。已重跑上游 `build:shell` → `build-official-shell` → 换快照（备份 `.dev/shell-backup-pre-02111-20261123-031800`）→ `patches:split`（70 个补丁）→ `shell:bake`。回归：`tests/shell-extras.test.mjs` 断言产物含新排版、旧排版消失。**待验**：完整重启后在桌面 GUI 用临时项目触发一次麦克风提示确认 `×` 在右。
- **2026-11-23 01:1x 插件启用失败（已修）**：`Cannot access 'studioCliGuard' before initialization` —— CLI 守卫的 `const` 放在 `createDiagnoseRoute(...)` 之后、却在之前作为值传入，装配期触发 TDZ；`apply()` 抛错使插件整块不激活，页面所有 RPC 变 503（`OFFICIAL_RPC_FAILED chat:load / agent:attach`）。修法：守卫在 `log` 之后、任何读取者之前创建（与 `router.mjs` 拆出的理由一致），`start()` 仍延后到 host-start 块。新增 `scripts/smoke-apply.mjs`（`npm run smoke:apply`，已并入 `npm run check`）：可调用 Proxy ctx 真正执行 `effect(fn)` 走完装配；**已用临时回退证明它能抓到该 TDZ**。

- **2026-11-22 强刷接回 / 删除同步 / 听写诊断 / 改名反馈（本工作区源码，未换壳快照、未重启）**：
  1. **强刷接回**：Host `attach` 在回合仍在运行时保留该回合的页面 key 并返回 `activeTurn`；新增只读 `agent:running` 供 `localAgents.running()` 使用，页面据此把正在跑的回合放回（不再重复发送）。忙冲突由 503 改为 409（不再触发底部红条）。测试：`tests/dsh-native-agent-service.test.mjs`（adoption 用例）、`tests/official-facade-events.test.mjs`。
  2. **删除同步**：`official-chat-store.deleteConversations` 在项目写队列内一次提交「删对话 + 清回合 + 更新 last/revision」，非法 ID 拒绝、冲突不回退为清空；路由只清目标对话的原生会话（`resetConversation`），成功后经事件 Hub 发 `conversation_deleted`，聊天页立即重读列表。测试：`editing-routes`、`official-chat-store-delete`、`shell-live-refresh`。
  3. **听写**：麦克风失败分五类（策略禁止/被拒/无设备/无法启动/环境不支持），提示按类给出，只上报错误类别。**宿主页面策略是否放行麦克风仍需在桌面 GUI 实测**。
  4. **改名**：偏好写盘失败不再被吞，接口回 `persisted:false`，侧栏保留输入并提示「重开后可能恢复原名」。
  5. **预览**：影片解析问题按行列出（先修第一条），缺标签不再挤成一句话；损坏提示保留换行。
  6. **导演预设**：系统提示新增 AUDIENCE FIRST，导演技能新增情绪线（`emotionArc`）与钩子兑现；分镜支持可选 `emotionArc` / `audienceBeat` / `hook`，旧分镜照读。
  - **壳与校验**：`vendor/official-shell` 已替换为最新构建（旧快照备份在 `.dev/shell-backup-20261123-000910`），`npm run shell:bake` 已重烤主题，`npm run check` 全绿（781 项）。**仍未真机验**：桌面需完整重启以加载新 Host 与新壳；重启后要复验强刷接回、删除同步、麦克风、改名与影片解析提示。
- **2026-11-23 官方 Studio 误开 / 编辑被撤销**：
  1. **不再打开浏览器**：Host 进程设 `OPENFILM_NO_BROWSER=1`（内核自带开关），`host-start` 日志多一个 `cliBrowser` 字段；Agent 用 shell 跑 CLI 也继承。
  2. **不再起第二个 Studio**：新增 [CLI 守卫](../src/studio/studio-cli-guard.mjs)，在 4747 上按内核认可的 health 形状（`product`/`version`/`home` 哈希/`filmOrigin`）回应 CLI，并把 `open` 变成「回工作台」的提示；`look`/`render` 在缺 `.film/opened` 时的自动 `open` 也走同一守卫。**实测**（临时项目 + 临时 home）：CLI 退出 0、不写 Studio home（只有它自己的 `key`）、不写 `.film/opened`、不起第二个 Studio、不弹浏览器。`NO996_STUDIO_CLI_GUARD=off` 可关；真人自己的 Studio 已在 4747 时守卫让位（日志 `occupied`）。日志：`studio-cli-guard` / `studio-cli-guard-hit` / `studio-cli-open-blocked`。
  3. **提示词与工具**：系统提示禁止用 shell 调 `openfilm look|render|open`；`no996_cli` 被拒时说明为什么；`no996_film` 在 Studio 运行时提醒直接改写 film.html 会让未保存编排失效。
  4. **编辑不再只能二选一**：编辑被外部改写撤销时，Studio 横幅新增「先存一份」下载 JSON，并写明这些编辑只存在页面里、刷新即丢。
  - **校验**：`npm run upstream:verify -- --dir .dev/verify-checkout` 在干净固定版 checkout（715c3a6）上重放 **70/70 补丁全部成功**；`npm run upstream:verify` 在已打补丁的工作树上原本会报 70 个冲突，现在改为明确提示改传 `--dir`；`npm run check` 全绿。facade 补了 `running()` 用例（只接本项目的合法条目、无项目/被拒返回空）；听写失败分类抽成 [mic-failure.mjs](../src/native/mic-failure.mjs) 并测“只记类别、不记文本/未知码”；系统提示补两条守门测试（AUDIENCE FIRST 在动效标准之前、禁止 shell 跑 CLI）；`no996_cli` 补“为什么拒绝”的测试。
  - **待真机**：重启后确认 CLI 不再弹页面、4747 被 CLI 守卫接住（`studio-cli-guard` 日志）、横幅出现「先存一份」。守卫状态已进 `POST /api/no996-openfilm/diagnose` 的 `cli` 字段（`held`/`occupied`/`disabled`），`occupied` 另记 `studio-cli-guard-occupied`。**残留已清理**：那次 bug 的 4132/32264 已停止，4747 空闲；实测守卫在 4747 上 `held`、health 的 `home` 哈希与本机一致、`/api/open` 返回改名提示（不接管项目）。`~/.openfilm/run.json` 仍留着指向已退出进程的旧记录，CLI 探测失败后会回落到 4747 守卫，不需要删它。


- **0.19.12 桌面项目创建修复**：代理启动失败不再污染其他入口；桌面回环地址与端口有针对性回退，创建与监听故障统一结构化记录。先在 Apple Silicon Mac（报告中的平台）及 Windows DSH 桌面用临时项目验证「复制开工」「空白开工」和诊断导出；不要以 Windows 自动化代替 macOS 真机。

- **2026-11-20 剪辑聊天（0.19.0，已发布源码与包，真机验收仍待做）。** 已核对本机 desktop profile 指向本工作区 `link:`，固定版 OpenFilm 壳已重建，补丁重放和测试通过。此证据不等于正在运行的桌面已加载新 Host，也不等于真实模型、搜索或安装技能已验收。
- **源码变更**：模式/当前模型独立于用户正文；支持手动切换、切回 Auto 归初始阶段和模型动态更新实际阶段。活动行收口，窄栏容纳失败状态及可展开的网页/命令详情；推理切换使用实际档位并保留默认。`/` 与「＋ → 技能」共用选择入口，分剪辑预设与 OpenFilm 已安装两组。实现与限制见[架构](ARCHITECTURE.md#23-聊天桥实时模式和显式技能)。
- **验收**：在 DSH `0.2.2-rc.5` 完整重启后用临时项目：① 窄栏触发搜索失败并展开原因、结束后重开历史，确认无覆盖/残留思考；② 切换不同档位的模型、手动→Auto→阶段变化，确认模式与模型不进入用户气泡；③ 验证两组同名技能互不覆盖、OpenFilm 停用后不可选/不可发、未引入全局 DSH 技能。
- **重连与恢复待复验**：桌面临时会话连续跨两次凭据续期，再断网重连；确认接回原回合、不重复发送、不残留思考，并检查预览全屏和命令详情。区分主动取消与健康探针真正超时，不把探针未计入失败写成通过。
- **2026-11-20 模板精简与壳补丁重排（0.19.11）。** `replica-film`（原"知识大赏"入口）整包移除、`_kit/replica` 复刻单元删除，模板说明改为按需读取（手动放入的外部模板可搜索不可执行，对照项目指令无新模板块）；上游壳补丁系列重排至 80 个并重建快照（登录门、引导、账号、示例画廊、项目库、导航、品牌等界面补丁更新）；登录/游客会话保持、偏好、Studio 插件面/影片视图桥接、素材库检索等 bug 修复；新增 `dev:up` / `dev:dsh` 本机联调脚本。源码已就绪，**待真机**：桌面重启后核对模板列表无复刻入口、登录/游客流程与示例/项目库页面表现。

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
| 技能隔离 | 剪辑预设组与包内注册目录一致，不列 Office/imagegen 等全局技能；另行显示启用的 OpenFilm 技能。`/diagnose` 显示预设技能根与注入情况。 |
| 环境查看页 | 打开插件详情页「剪辑环境」，核对预设、技能和影片工具；填写项目 ID 能查询指令链与预算，不以历史固定数量验收。 |

## 下一步

- [工作台统一升级方案](topics/local-models-and-native-capabilities-plan.md)：可编辑成片、素材取用、口播转写、本地模型与存储、原生搜索。
- 工作台整合的既有验证：源码快照与 46 个上游补丁已重建并在干净的固定版本检出验证可应用；原快照备份在忽略目录。免费页面转场整链已跑通（`node scripts/transition-frame-check.mjs`）：官方库搜索「glitch」→ 取进临时项目 → 带版本守卫放到 3 秒切点（2.88–2.94 秒覆盖切点，2.80 秒仍是上一镜，3.20 秒已是下一镜）→ 真实导出 6.0 秒 MP4（h264_nvenc，52 KB）；素材未授权、锁轨、版本冲突、空回执和丢失回执都有拒绝路径与测试。示例引用的上游草稿编码到 Host prompt 已用固定版上游源码和 mock 桥测试；模板扩展目录的发现及复制、创建后附加记录失败的回执已测。
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
- 模板按需读取：用桌面临时项目验证 9:16 空白画布、包内模板复制及打开、手动放入的外部模板可搜索而不可执行；对照项目指令确认没有新模板块。分镜可视化另行设计。
- 不加班工作台统一 API Key（`is_default` 不可删除可轮换）+ `no996/auto` 智能路由（支持图片理解）+ DSH Web Search/Fetch + Studio 生图/配音/搜网/预留视频桥接 + 右侧工作台首页抽屉（扣费明细/可调模型费率表/默认密钥卡片）。**待真机**：登录后首句对话自动选用 `no996/auto` 并签发默认 Key；发送图片可正常识图与扣费；右侧抽屉实时展示积分明细与模型费率。
- **连续生长动效 v2、内置 Vibe BGM、「完成后自动导出」二级开关与品牌化全量素材工具层**（当前工作区 `0.18.0`）：
  1. `WorkModePill` 弹层底部新增「完成后自动导出」开关（`autoExport` 默认关，按 `(projectId, conversation)` 持久化并广播 `mode_update`）；`no996_export` 对 `video/gif/audio/slides/nle` 强制要求 `autoExport === true` 或 `explicitUserRequest === true`（`stills/poster/subtitles` 放行）。
  2. 内置 Vibe 科普剧场曲目 `We Never · 若如初见`（26 KB 实测拍点 `vendor/media/bgm/vibe-we-never.rhythm.json` 随包分发；音频实体按需多源校验 SHA-256 缓存在 `$DSH_HOME/no996-openfilm/media/bgm/we-never.mp3`），`no996_audio` 支持 `bgm-list` / `bgm-install` / `extract` / `duck`（-12 dB 人声闪避）；`no996_assets` 新增 `inspectUrl` / `fromUrl` 网页图片安全抓取（SSRF 防护）。`replica-film`（原「知识大赏」入口）已整包移除，产品列表与提示词注入不再提供该选项。
  3. `_kit` 连续舞台引擎（`motion.js`、`vibe-canvas.js`、`page.mjs`、`templates-build.mjs`）支持 `continuousStage`、2.5D 相机视差、6 类生长转场、因果交互与对话/声纹/首尾帧组件；`vibe-explainer` 已重构为 8 镜单镜头连续生长 `stage.js`（零 `drawWipeBand`），无头 Chromium 6 切点帧抽检通过。
  4. **动效设计四大核心原则**与**剪辑师六阶段工具/素材库调用时机表**已锁定至提示词、`storyboard.mjs`、`openfilm-director/vibe-craft/motion/editing` 与 `docs/MOTION.md`。
  5. **工具前缀品牌化与全量花字/字体/滤镜/双源模板打通**：Host 21 个工具统一暴露 `no996_*`（UI 活动行同时兼容识别历史 `openfilm_*`）；新增 `no996_fonts` 扫描系统/项目/内置 OFL 字体；`no996_library` 补齐 `wordart`（41 款花字）/`textmotion`（31 款）/`motion`（64 款）/`layer`（5 款）/双源 `template`（不加班模板 + 官方 14 套）检索与 `inspect` 配方透视；`no996_clip` 支持通过 Studio `/edit` 直接 `insert` / `preset` / `remove` 花字、字体、LUT 滤镜与关键帧。
  **待真机**：DSH 桌面端重启后核验 `WorkModePill` 二级开关、`no996_*` 活动行、`no996_fonts` / `no996_library` / `no996_clip` 联动、以及 `no996_audio` 首用安装 `we-never.mp3`。

## 明确不做

预览/渲染沙箱、余额展示、技能卡、macOS/Linux 真机验收。不要把待做写成已完成。
