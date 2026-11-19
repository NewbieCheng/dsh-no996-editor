<!-- doc
id: playbooks-publish
reader: 智能体、发版的人、装/更新插件的人
fact-source: package.json、scripts/npmjs-publish.ps1、scripts/pack-tgz.mjs、真机 DSH 插件详情「版本」区
checked: 0.16.1
rot-if: 换 registry、包名、scope 大小写规则、或 DSH 安装/更新方式变化
-->

# 手册：安装 / 更新 / 发版

> **本仓唯一正式手册。** 装、更、发只认这篇。  
> 源码 → GitHub；产物 → npmjs.org；包名必须小写。

## 0. 30 秒地图

| 项 | 值 |
|---|---|
| 包名 | `@newbiecheng/no996-editor`（**全小写**；大写 scope → 无「版本」区） |
| Registry | `https://registry.npmjs.org/` |
| 产物 | https://www.npmjs.com/package/@newbiecheng/no996-editor |
| 源码 | GitHub `NewbieCheng/no996-editor`（`main`） |
| 本机发版脚本 | `scripts/npmjs-publish.ps1`（读 `.npmjs-token.tmp` 或 `NPM_TOKEN`，需 bypass-2FA 的发布 token） |
| CI 发版 | 暂未配置；本机脚本发版 |

谁干什么：

- **用户 / 桌面**：registry 装与更新；看 DSH 插件详情「版本」。
- **维护者 / 智能体**：改版本 → 闸门 → 发 npmjs → 真机验收。
- **不要**：GitHub Release、本地 `.tgz` / `link:` 当用户通道；也不要再发 GitLab。

---

## AI 开发到交付 SOP（最短路径）

> **授权边界（当前阶段）**：本机调试安装已由用户授权——工作区构建可以装进本机 `desktop` profile 用于验证；装前记下当前版本、装后告知需要重启，验证完可按记录回滚。**发版不是默认下一步**：改版本号、提交、推送、打 tag、`npm publish` 只在该用户当轮明确要求时执行，不随开发或验收自动串联。

按用户要求选择终点：**开发验证 ≠ 提交 ≠ 推送源码 ≠ 发布包 ≠ 更新用户桌面**。仅要求开发或写文档时停在对应步骤；提交、推送、发布、安装或重启都要有用户对相应操作的授权，不因前一步自动执行下一步。

1. **开工前**：读根目录 `AGENTS.md` 和相关文档；运行 `git status --short --branch`、`git remote -v`，确认当前分支、工作区和源码远端。保留用户已有改动，不擅自清理、暂存或提交；目标分支、远端或发布范围不明确时先问。运行 `dsh --version`，需要使用 DSH 插件 API 时先查运行时 inspect / 当前版本文档。
2. **开发和本地验证**：按需求修改，新增行为补测试；禁止测试调用真实模型。日常可先跑 `npm run check:quick`（变更文件语法、全量文本规则和自动识别的相关测试）；自动识别可能遗漏，需按改动补测试；提交前仍须执行 `npm run check`。改 `.upstream/openfilm` 官方壳时，在 Windows 下需用大写盘符路径执行 `npm --prefix "F:\...\apps\desktop" run build:shell`（与 `shell/vite.config.ts` 的 `CHAT` 路径前缀一致），再同步 `shell/dist` 到 `vendor/official-shell/ui/`、跑 `npm run patches:split` 与 `npm run shell:bake`；客户端入口改动再执行 `npm run build`；改模板 `_kit` / `shots` 执行 `npm run templates:build`；源码或路由影响生成文档时执行 `npm run docs:gen`，然后重跑相关检查。按 `docs/DEVELOPMENT.md` 的生效矩阵验改动；涉及界面的结果必须真机验证，不能用构建成功代替。
3. **只在要求提交/推送源码时**：先检查 `git diff`、待提交文件及暂存区，仅暂存本次授权范围；有不属于本任务的改动就保留并说明。确认后提交；需推送时核实远端确为 GitHub `NewbieCheng/no996-editor`、分支和目标，再推送。GitHub 是源码主仓；npmjs.org 只承载发布包。
4. **只在要求发版时**：按 §3 确定未占用的新版本并同步版本、锁文件、CHANGELOG 和 STATE；准备烘焙及构建产物，检查变更并按授权提交。干净工作区运行 `npm run release:check`：它会检查版本和 Git、查询 registry、运行完整检查，并在临时目录构建和打包验证；任何一项失败都停止。它不发布，也不支持跳过正式闸门。通过后才依 §3.3、按授权发布。
5. **发后核验 / 更新**：按 §3.4 查询 npmjs registry 对应版本并在 npmjs.com 核对；仅用户授权时更新 desktop，先保存未保存编辑，按提示整应用重启。真机确认「版本」及侧栏功能；无法访问真机则明确标记待验，不能声称端到端完成。交付时报告改动、测试、源码提交/推送、发布版本、安装/重启和真机验证各自的实际状态及阻塞。

> 本地脚本发布是默认路径：发布 channel 固定为 npmjs.org（唯一保留完整 packument、让 DSH GUI 可更新）。`.gitlab-ci.yml` 已停用。禁止泄露、提交 token 或临时 npm 配置。

---

## 1. 用户：安装（一次配置 + 一次安装）

### 1.1 配置 scope（一次）

`~/.npmrc` 或 `$DSH_HOME/profiles/<profile>/.npmrc`：

```
@newbiecheng:registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=<npm-token>
```

- 默认源可继续是 `registry.npmmirror.com`；**不要**用它做插件源（它的 packument 是精简版，GUI 更新读不到 `dsh`）。
- Token 不进 git。

### 1.2 安装

```powershell
dsh plugin --profile desktop add @newbiecheng/no996-editor
```

或在 DSH 插件管理器按包名安装。出现 `restart-required` → **整应用重启** DSH。

### 1.3 装好长什么样

`~/.dsh/profiles/desktop/package.json`：

```json
"dependencies": { "@newbiecheng/no996-editor": "0.15.29" },
"dsh": { "profile": { "bundles": [ "…", "@newbiecheng/no996-editor" ] } }
```

物理目录必须存在：

`~/.dsh/profiles/desktop/node_modules/@newbiecheng/no996-editor/package.json`

插件详情应有「版本」区；代码来源类似 `@newbiecheng/no996-editor@0.15.29`（不是本机路径、`link:`、`file:.tgz`）。

---

## 2. 用户：更新

1. 维护者发新版后，打开插件详情 →「版本」→ 有新版本则点更新；或点「重新检查」。
2. CLI：`dsh plugin --profile desktop add @newbiecheng/no996-editor@<新版本>`
3. `restart-required` → 整应用重启。更新前保存 Studio 未保存编辑。

验收：当前版本号 = 刚发的版本；「已是最新版本」或等价文案。

---

## 3. 维护者 / 智能体：发版

按顺序做，不要跳步。

### 3.1 改版本与说明（同批）

1. 查询已发布版本：`npm view @newbiecheng/no996-editor version --registry https://registry.npmjs.org/`；结合 `git tag --list 'v*'` 与本地版本选未占用的新版本。查询失败先排查权限、网络或 registry，不能当作未发布。
2. `package.json` 的 `version`；`package-lock.json` 的顶层 `version` 和 `packages[""].version` 同步。
3. `CHANGELOG.md` 顶栏新节只写用户可见变化、兼容性和必要迁移；复杂故障证据放排障手册，历史版本不改写。`docs/STATE.md` 更新当前版本与 `checked`；其他写死当前版本的说明也要核对，或改为引用版本来源。

包名保持 `@newbiecheng/no996-editor`。若改了客户端入口 / `cordis.patch.yml`，确认模块名与 ModuleLoader `id` **等于包名**。

### 3.2 本地闸门

```powershell
npm run shell:bake
npm run build
# 检查生成物并按授权提交；正式发版要求工作区干净
npm run release:check   # 完整检查、registry、临时构建/打包；不发布
```

### 3.3 发布到 npmjs.org

```powershell
# 仓库根；需 .npmjs-token.tmp 或环境变量 NPM_TOKEN（bypass-2FA 的发布 token）
powershell -ExecutionPolicy Bypass -File .\scripts\npmjs-publish.ps1
```

npmjs 的发布 token 需 **Bypass two-factor authentication (2FA)** 且权限为 `Read and write (publish and stage)`；否则 publish 会被 401/403 拒绝。

脚本会：`build` → `pack-tgz.mjs` → `npm publish` 到 `publishConfig.registry`。

### 3.4 发布后验收（未过不许写「完成」）

```powershell
npm view @newbiecheng/no996-editor version --registry https://registry.npmjs.org/
```

- 输出 = 刚发的版本
- https://www.npmjs.com/package/@newbiecheng/no996-editor 能看到该版本
- 真机：desktop 已是 registry 包 → 更新或重装 → 整应用重启 →「版本」区与侧栏「视频创作」正常

**为什么必须是 npmjs.org（2026-11-19 实证）：** DSH 的版本区靠 `pnpm view <包名>@<版本>` 的 `dsh.bundle` 判定能否安装。GitLab 与 GitHub Packages 落库都不保存 `dsh`，GUI 会显示「没有声明组合包，无法安装」；npmjs.org 保留完整 packument。CLI 更新在两种 registry 下都可用，但 GUI 更新只有 npmjs 可用。

```powershell
dsh plugin --profile desktop add @newbiecheng/no996-editor@<版本>
```

发布后运行 `node scripts/verify-registry-dsh.mjs`：它检查源码里的 `dsh.bundle.patch` 并核对 registry 是否保留。输出 `REGISTRY-GUI: dsh bundle declaration present` 才算 GUI 可更新；输出 `RELEASE-PACKAGE` 且退出码 1 是包本身出错。

桌面若只改了 `package.json`、磁盘上包丢了：

```powershell
dsh plugin --profile desktop install
```

---

## 4. 回滚

```powershell
dsh plugin --profile desktop add @newbiecheng/no996-editor@<旧版本>
```

或对该 bundle `disabled: true` / `dsh plugin remove @newbiecheng/no996-editor`。

---

## 5. 踩坑（真机已踩）

| 症状 | 原因 | 处理 |
|---|---|---|
| `ERR_PNPM_IGNORED_BUILDS`（`ffmpeg-static` / `protobufjs`），退出码 1 但依赖其实已经装上 | DSH 自带 pnpm 11 默认不给依赖跑安装脚本；`allowBuilds` 必须在 profile 的 `pnpm-workspace.yaml` 里（`onlyBuiltDependencies` 已被 pnpm 11 取代） | 在 `$DSH_HOME/profiles/desktop/pnpm-workspace.yaml` 加 `allowBuilds` 下 `ffmpeg-static: true`、`protobufjs: true`，再跑一次 `add`；不加也能用，但 ffmpeg 二进制与 protobuf 的安装脚本不会执行 |
| 有插件、无「版本」区 | scope 非全小写，过不了 DSH `PACKAGE_NAME` | 必须用 `@newbiecheng/…` 重发并重装 |
| 「包不可用」/ cannot resolve bundle | `node_modules/@newbiecheng/no996-editor` 不存在 | `dsh plugin --profile desktop install`；勿手删 scope 目录 |
| Windows 删 `@NewbieCheng` 把新包装没了 | NTFS 大小写不敏感，两 scope 是同一目录 | 只 `dsh plugin remove/add`，不要手删 `@*newbie*` |
| 「版本」在但像连不上源 | 装错 registry（GitLab/GitHub 丢 `dsh`）| 发布通道必须是 npmjs.org |
| 侧栏「视频创作」没了 | 客户端 ModuleLoader `id` ≠ 包名 | `id` / cordis 模块名改成包名全文，发补丁版 |
| 代码来源是路径 / `link:` | 本地开发链 | 验收「版本」Tab 前改回 registry 包 |

---

## 6. 禁止

- 用 GitHub Release / 本地 `.tgz` / `file:` / `link:` 给**用户**装或更新
- 把 token / `.npmjs-token.tmp` / `.npmrc` 提交进仓
- 混合大小写 scope（`@NewbieCheng/…`）
- 未真机看到「版本」与侧栏就声称发版完成
- 改 `openfilm` tarball 源却不同步三处 pin（见 AGENTS / upstream-bump）
