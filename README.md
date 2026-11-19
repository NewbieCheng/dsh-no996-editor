# 不加班剪辑 · No996 Studio

把 **OpenFilm 0.4.0** 视频工作台做成 DSH 插件：官方 Studio 与桌面壳整页常驻在侧边栏，右侧对话在 Host 进程内直连 DSH 原生 `SessionController`（绑定 `openfilm-video-editing` 预设）。

版本以 `package.json` 与 [CHANGELOG.md](CHANGELOG.md) 为准；"现在到哪了"看 [docs/STATE.md](docs/STATE.md)。仓库：`NewbieCheng/dsh-no996-editor`，分支 `main`。

## 安装

包名：`@newbiecheng/dsh-no996-editor`（npmjs.org）。

1. 包发布在 npmjs.org，无需 token；直接用：`

```powershell
dsh plugin --profile desktop add @newbiecheng/dsh-no996-editor
```

或在 DSH 插件管理器按包名安装。安装 / 更新 / 发版手册：[`docs/playbooks/publish.md`](docs/playbooks/publish.md)。

需要：

- DSH 内核（含 `session-controller`、`storageDomain`、`webServer`）
- Node.js 22.2+
- `ffmpeg` / `ffprobe`（读视频信息、部分处理）；缺了会在界面里提示，不会自动安装

更新：从 registry 安装的包可在 DSH「版本」Tab 检测并一键更新；出现 `restart-required` 时按提示重启 DSH。更新前先保存未保存的编辑。发布包已内置 OpenFilm 运行时、官方界面与模板，不需要另外装 OpenFilm。

## 用起来

- 侧边栏「视频创作」打开工作台；官方界面的对话列由 Host 进程内的 DSH 原生 `sessionController` 驱动。
- **一条对话 = 一条原生 DSH 会话**：同一个项目里新建对话就是新会话；回到旧对话使用对应会话。工作目录是项目文件夹。
- 对话里能看到思考、工具调用（真名 + 参数 + 结果摘要）、内联图片；审批走 DSH 自己的界面，不会被静默放行。
- 图片：当前模型支持看图时内联发送；不支持时落成临时文件并以绝对路径引用。上传兜底单文件上限 256 MiB；更大的视频请先剪辑或转码。
- 项目首次被面板打开时，Host 会在项目文件夹写一份 `AGENTS.md`（编辑指令，已存在则绝不覆盖）。
- 本地口播转写：`openfilm_transcribe`，视频/音频 → 带时间码文稿；首次下载 228 MB 权重。
- **剪辑与动效伙伴**：根据任务选择剪辑、动效、口播或画面制作；影片文件夹是指令链的根，仓库上层的手册不会进入影片对话。
- **分镜工具**：`openfilm_storyboard` 读写 `.film/storyboard.json`；需要口播转写时再用 `from-script`、`subtitles` 和 `plan`，简单问答或小改动不强制完整流程。
- **模板可发现**：`openfilm_library kind=template` 列出内置模板，`readTemplate=<id>` 只读说明，`take=<id>` 才启用模板。
- 常驻上下文有预算（persona + 指令文件 ≤ 6 KB），风格库/镜头卡/模板全文都按需读。

## 文档

| 文档 | 给谁 | 内容 |
|---|---|---|
| [docs/index.md](docs/index.md) | 所有人 | 文档地图：哪篇属于规格/决策/参考/流程/进度 |
| [AGENTS.md](AGENTS.md) | 智能体 | 红线、改哪一层、生效矩阵、证据入口 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发者 | 启动时序、请求路径、模块职责、构建 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 开发者 | 进程模型与边界（不含进度） |
| [docs/STATE.md](docs/STATE.md) | 所有人 | 唯一写进度的一篇：当前版本、能用、待真机验、明确不做 |
| [docs/decisions/](docs/decisions/README.md) | 维护者 | 每条设计决定的理由与代价（ADR） |
| [docs/decisions/ADR-0009-ui-change-strategy.md](docs/decisions/ADR-0009-ui-change-strategy.md) | 改界面的人 | 界面改动方式的历史决策；当前注入清单见 reference |
| [docs/playbooks/publish.md](docs/playbooks/publish.md) | 装/更/发的人与智能体 | 安装、更新、发版、回滚（唯一手册） |
| [docs/playbooks/upstream-bump.md](docs/playbooks/upstream-bump.md) | 维护者 | 三处 pin、补丁系列、升级与冲突 |
| [docs/playbooks/incident.md](docs/playbooks/incident.md) | 排障的人 | 症状 → 根因 → 现在靠什么挡住 |

专题：[模板](docs/TEMPLATES.md)、[动效（含风格库与镜头卡）](docs/MOTION.md)、[口播转写](docs/TRANSCRIBE.md)、[品牌](docs/BRAND.md)。
通用 skill（独立仓库）：[dsh-harness-remix](https://github.com/NewbieCheng/dsh-harness-remix)（DSH UI 改造 + 后端衔接）。

## 能力与边界

- 已接通：项目/对话（按对话隔离会话）/模型/审批/取消、思考与工具行、内联图片、归档、模板安装与检索、抽帧、时间轴落盘编辑、导出、CLI 兜底、本地转写、分镜与字幕。
- 未完成：余额展示、官方输入框在部分场景只读、默认权限不是完全访问、技能卡、预览/渲染沙箱、macOS/Linux 真机验收。
- 账号：接工作台账号（不是 OpenFilm 站点账号）；未登录由壳内登录页挡住剪辑。`NO996_OPENFILM_DEV=1` 可跳过账号门做开发。

细节和"为什么"以文档为准；进度只在 [`docs/STATE.md`](docs/STATE.md)，不要把"待做"写成"已完成"。

## 许可

本仓库的接入代码为 MIT。官方 OpenFilm 的构建产物、许可证与商标声明见 [vendor/official-shell](vendor/official-shell) 与 `THIRD_PARTY_NOTICES.md`；产品名与标识不代表上游背书。

---

## English summary

`dsh-no996-editor` packages the official OpenFilm 0.4.0 studio and desktop shell as a DSH plugin. The Host starts the official Studio on a loopback port, reverse-proxies it, and bridges the shell's chat column to a DSH session (models, approvals and cancellation stay DSH's). The official UI is vendored as a pinned build with a reviewable, replayable source patch series.

Install `@newbiecheng/dsh-no996-editor` from npmjs.org (see `docs/playbooks/publish.md`). Node 22.2+, DSH with `session-controller`/`storageDomain`/`webServer`, and `ffmpeg`/`ffprobe` for video metadata. Upstream is MIT; its license, notices and trademark terms are preserved under `vendor/official-shell`. Product names and marks here do not imply upstream endorsement.
