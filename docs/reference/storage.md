<!-- doc
id: storage
reader: 维护者、要加持久化的人
fact-source: src/official/official-chat-store.mjs、src/native/dsh-session-store.mjs、src/studio/studio-controller.mjs、DSH 的 storageDomain
checked: 0.19.0
rot-if: 换存储介质、或 DSH 改 storageDomain 形状
-->

# 数据与存储

> 原则：会话、聊天记录、映射和影片都是不同的数据；不要假定删除任一份后都能无损重建。

## 1. 存什么、在哪

| 东西 | 位置 | 真相还是提示 |
|---|---|---|
| 官方聊天记录 | DSH `storageDomain`（`no996_openfilm_official_chat`） | 插件聊天记录；不覆盖上游 `.film/chat` |
| 原生会话映射 | `$DSH_HOME/no996-openfilm/native-sessions.json` | 项目与对话到原生会话的映射；不要擅自删除 |
| 会话历史本体 | DSH 会话持久化目录（内部格式和布局以宿主版本为准） | **由 DSH 管理，插件不直接改写** |
| 附件（抽帧图等） | `$DSH_HOME/attachments/v1/objects/<前2位>/<sha256>` | 内容寻址 |
| 片型引导偏好 | `$DSH_HOME/no996-openfilm/preferences.json` | 提示（本机安装级） |
| 账号会话 | `$DSH_HOME/no996-openfilm/workbench-auth.json` | token 只在 Host |
| 预设激活报告 | `%TEMP%\no996-editor-preset.json` | 诊断 |
| 插件日志 | `%TEMP%\no996-editor\plugin.log`（JSON Lines，脱敏） | 诊断 |
| 帧记录 | `%TEMP%\no996-editor-frames.jsonl`（每轮覆盖） | 诊断 |
| 影片项目 | 用户选择或 Studio 登记的项目目录（含 `film.html`、`assets/` 等） | 用户数据；不纳入源码或发布包 |

## 1.1 本机影片库

仓库内若存在 `films/`，它也是用户数据；不要移动、删除或迁移。项目默认位置和已有项目位置可能不同，操作前以实际配置及项目列表为准。关于仓库内的 `films/`：

- `.gitignore` 有 `/films/`，`package.json` 的 `files` 白名单也没有它，所以既不会被提交，也不会被打进发布包；
- `tests/repo-hygiene.test.mjs` 检查仓库忽略和打包规则；不要通过强制添加来绕过。
- 不要直接改写项目登记或移动用户项目；先检查当前 Studio 配置和诊断证据。

## 2. 永不删除

- 用户 Session（只归档，不删文件）；
- 上游 `.film/`；
- 项目文件（删除项目走回收站 `rename`，并由用户确认彻底删除）。

## 3. 写文件的规矩

1. **原子**：tmp → `rename`；失败回滚（Windows 上目录被占用会 `EPERM`，要有 409 和人话错误）；
2. **有上限**：JSON 读取前先看字节数，损坏就当默认值；
3. **可重建**：提示性数据损坏时，允许"重建而不是报错"；
4. **串行**：同一个文件的读改写排队，避免并发丢更新；
5. **不猜形状**：DSH 返回的字段以真机日志为准，旧扁平/新嵌套都兼容时写测试。

## 4. 诊断要什么

- 一条命令：`POST /api/no996-openfilm/diagnose { projectId }`，面板静默 20 秒后自动贴出；
- 诊断包含日志位置及指令链等信息；分享前检查并去除用户路径、凭据与其他隐私，不能假设所有字段均已脱敏；
- 原生会话日志入口：`native-session`、`native-prompt-start`、`native-prompt-failed`；旧 ACP 日志仅供历史故障参考。

## 5. 不要做

- 不要解析 `session.v4.jsonl.zstd` 后写回（那是 DSH 的格式）；
- 不要把业务状态塞进 `localStorage` 当真相；
- 不要在注入层读写业务存储。
