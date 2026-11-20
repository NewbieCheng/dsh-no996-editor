<!-- doc
id: reference-packaging-and-distribution
reader: 打包发布者、排查坏包或跨平台环境问题的开发者
fact-source: package.json, scripts/build-official-shell.mjs, scripts/release-check.mjs, src/host/download-sources.mjs, src/host/download-stall.mjs, src/tools/tool-installer.mjs, cordis.patch.yml
checked: 0.19.11
rot-if: 修改 bundledDependencies/optionalDependencies、打包脚本、下载源或跨平台工具配置
-->

# 打包、分发与跨平台环境保障

本文说明 OpenFilm 源码如何构建进插件包、发布包如何避免缺依赖变成"坏包"，以及 FFmpeg / SenseVoice 模型的多源切换与 Windows / macOS 适配边界。

**安装 / 更新 / 发版步骤**不在这里——只认 [`playbooks/publish.md`](../playbooks/publish.md)。

## 1. OpenFilm 源码打包流水线

```text
上游 checkout（固定版本；目录可配置）
  ├─ 应用 patches/ 中的源码补丁（由 patches/series.json 约束 sha256）
  ├─ 先构建静态前端，再用 node scripts/build-official-shell.mjs 打包快照
  │    └─ 输出 vendor/official-shell/ui/ + vendor/official-shell/manifest.json（逐文件 sha256）+ patch.diff
  ├─ npm run shell:bake
  │    └─ 将主题变量烘焙进 vendor/official-shell/ui/assets/no996-theme.css 并重算 manifest
  ├─ npm run build
  │    └─ esbuild 将 src/studio/studio-entry.js 等打包为单文件 client.js
  └─ `scripts/pack-tgz.mjs` + `scripts/npmjs-publish.ps1`
       └─ 发布 `@newbiecheng/dsh-no996-editor` 到 npmjs.org（见 [`playbooks/publish.md`](../playbooks/publish.md)）
```

## 2. 分发依赖矩阵（防坏包机制）

用户从 **npmjs.org** 安装；tarball 仍按 `files` + `bundledDependencies` 打齐，依赖按"随包内置"与"平台按需"两层隔离：

| 类别 | 包含项 | 分发方式 | 说明 |
|---|---|---|---|
| 核心运行引擎与契约 | `openfilm@0.3.2`、`zod` | `bundledDependencies` | 随包内置，用户装插件时无需再拉这两个 npm 包 |
| 插件壳与预设资产 | `index.js`、`client.js`、`src/`、`vendor/official-shell/ui/`、`vendor/templates/`、`vendor/providers/no996/`、`skills/`、`assets/`、`locale/`、`cordis.patch.yml` | `package.json` `files` | `vendor/official-shell/ui/` 带 `manifest.json` sha256 校验 |
| 媒体与本地语音原生包 | `ffmpeg-static`、`ffprobe-static`、`sherpa-onnx-node` | `optionalDependencies` | 设为可选依赖，防止某平台缺少预编译二进制时阻塞整个插件安装 |

> **关键打包约束**：跨平台发布的 `.tgz` 不得把单平台 `node_modules/sherpa-onnx-node` 下的 Windows `.node` 原生二进制混进 tarball，否则 macOS 用户安装后本地转写原生引擎会因架构不匹配而不可用。原生包应由目标端按 `optionalDependencies` 匹配或走内置下载器补齐。

## 3. 外部工具与模型的多源自动切换与卡死保护

核心工作台与时间轴不依赖外部下载即可启动；仅当用户使用视频转码/探测或本地口播转写时，才按需触发下载（`src/host/download-sources.mjs`、`src/host/download-stall.mjs`、`src/tools/tool-installer.mjs`）：

| 资源 | 探测顺序 | 自动切换下载源 | 保护机制 |
|---|---|---|---|
| **FFmpeg / FFprobe** | 1. 随包 `ffmpeg-static` / `ffprobe-static`<br>2. 系统已装（Windows: WinGet / Scoop / Chocolatey；macOS: `/opt/homebrew/bin`、`/usr/local/bin`、`/usr/bin`）<br>3. `$DSH_HOME` 私有工具目录 | 国内镜像 `npmmirror` → 官方源 `github` / `npm` | `download-stall.mjs` 连接/空闲卡死看门狗，超时自动中断并切换备用源 |
| **SenseVoice 口播模型**（约 228 MB） | `$DSH_HOME` 本地模型目录 | 国内镜像 `hf-mirror` → 官方 `huggingface`（支持 `NO996_OPENFILM_ASR_BASE_URL` 覆盖） | 未下载时不阻塞其余所有剪辑与对话功能 |

## 4. Windows 与 macOS 适配边界

| 维度 | Windows | macOS |
|---|---|---|
| 系统工具探测 | WinGet / Scoop / Chocolatey / PATH | Homebrew（`/opt/homebrew/bin`）、`/usr/local/bin`、`/usr/bin` |
| 下载 URL 架构匹配 | `win32-x64` / `win32-arm64` | `darwin-x64` / `darwin-arm64` |
| 预设终端工具（`cordis.patch.yml`） | `tool-pwsh` | `tool-bash` |
| 真机 GUI 验收情况 | 已通过真机桌面端验证 | 仅完成代码路径与跨平台参数适配，**尚未在 macOS 真机上做完整 GUI 验收** |
