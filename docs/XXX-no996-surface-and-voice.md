<!-- doc
id: xxx-no996-surface-and-voice
reader: 后续维护的人或智能体
fact-source: src/voice/*、assets/theme/studio.css、studio-proxy、workbench-auth
checked: 0.15.22
rot-if: 恢复官方服务商 UI、卸掉 no996 provider、或改工作台配音契约
-->

# XXX · 表面收敛 + 不加班配音兼容层（本次改动）

> **藏，不删。** 官方 ElevenLabs / 画布 / 媒体供应商代码与数据仍在；本页只记这次关掉了什么、怎么接回不加班音色。

## 1. 产品意图

| 要 | 不要 |
|---|---|
| 音色页 / Agent 用**不加班**账号里的复刻 + 平台音色配音 | 新造独立配音服务 / 任务队列 / 新 ACP 工具名 |
| 页面上不出现「服务商」分类与一堆第三方供应商 | 真删 `elevenlabs.mjs` 等上游文件 |
| 暂时不用画布模式 | 删掉画布源码 |
| Settings 媒体生成只留可用路径（OpenFilm + 不加班 + **本地服务**） | 用户去贴 ElevenLabs key；本地 ASR/抠图入口必须保留 |

## 2. UI 隐藏（可逆）

| 区域 | 手段 | 开关 / 恢复 |
|---|---|---|
| 素材抽屉音色侧栏「服务商」及 ElevenLabs / Inworld / Cartesia 行 | `assets/theme/studio.css`（B1） | 删对应规则或 `NO996_OPENFILM_THEME=0` |
| Settings → Services 除 openfilm / no996 / local 外的 chips | 同上 | 同上 |
| 顶栏「画布 / 剪辑」切换按钮 | 同上（`[data-work-mode]`） | 同上 |
| 进项目强制剪辑布局 | 代理 HTML 注入里已有 workspace seed；不新开 canvas | 改 seed / 清 localStorage |

注入登记见 [`reference/injection-registry.md`](reference/injection-registry.md)。

## 3. 配音：官方 Provider 兼容层（不造轮子）

官方链路不变：

```text
openfilm_get(verb=voice|tts) / 页面 Speak
  → Studio /api/get
  → providers/no996.run
  → 工作台 GET /v1/audio/voices + GET /api/v1/models/default-tts
       与 POST /api/v1/ai/audio/speech
  → 音频落 assets/audio/vo/
```

- **安装方式**：官方 `added providers`——Host 启动时把 `vendor/providers/no996/provider.mjs` 写入 `sharedHome/providers/no996/`（不是 fork BUILT_IN）。
- **已连接**：复用 Host `workbench-auth` 登录态（`ready()`）；浏览器仍不见 token。
- **桥**：`Symbol.for('no996.openfilm.voice')` 挂在同进程 `globalThis`；stub provider 只转发 `run`。
- **音色页**：代理改写 `GET /api/library/voices`，只露出 `provider: no996` 的复刻 + 平台音色（官方库数据仍在上游，不经代理）。
- **默认**：`providers.json` 的 `use.tts = no996`（登录且 ready 时）。

## 4. 明确不做（本轮）

- OpenFilm 内新建音色复刻（仍去工作台）
- 搬工作台 IndexedDB 任务队列
- 新 `openfilm_voice_*` 工具名
- 改后端 `/v1/audio/voices` / `/api/v1/ai/audio/speech` 契约

## 5. 验收

1. 登录后打开「配音」默认进**精选**（不是收藏）；应看到复刻 + 平台音色。收藏只有星标后才有。
2. 侧栏保留「全部 / 不加班」，无 ElevenLabs 等服务商行。
3. Speak / Agent `openfilm_get` tts 写出 `assets/audio/vo/*`。
4. 未登录：列表可为 0；提示登录，不是贴第三方 key。
5. 关主题注入后，官方服务商 UI 可再出现；卸 `providers/no996` 即回到纯官方。

## 6. 常见误会

| 现象 | 原因 |
|---|---|
| 收藏里「0 个音色」 | 收藏只显示你点过星的；点**精选**或**全部** |
| 精选也是空的 | 未重载插件 / 未登录 / `/api/library/voices` 改写未生效 |
| Agent 说「没有连接任何配音服务」、只剩 edge-tts | `provider.mjs` 的 `env` 曾是空串；官方 `added.mjs` 要求 `env` 非空，整份 provider 被静默丢弃。须 `env: 'NO996_WORKBENCH'`（不读真实环境变量，连接仍靠 `ready()` + 登录） |
