<!-- doc
id: playbooks-dev-live
reader: 新手开发者、调样式和改界面的同学
fact-source: scripts/dev-live.mjs、src/dev/index.mjs、src/dev/dev-browser-portal.mjs、src/host/distribution.mjs、src/host/diagnostic-log.mjs、scripts/pack-tgz.mjs
checked: 0.16.1
rot-if: dev:live 启动方式、环境变量、诊断日志目录或打包流程变化
-->

# 零基础开发指南：实时热更新、调样式与打正式包

这份文档专门写给第一次接手 `dsh-no996-editor` 的同学：**不用猜命令、不用反复按 F5、改样式和 React 代码保存即生效，改完再一键落成正式可分发插件包。**

---

## 一句话先看懂：改不同文件怎么生效

| 你想改什么 | 改哪个目录 | 保存后怎么生效 |
|---|---|---|
| OpenFilm 界面 React / TSX / Tailwind 样式 | `.upstream/openfilm/`（例如 `packages/openfilm/studio/ui/src/` 或 `apps/desktop/chat/src/`） | **Vite Fast Refresh 毫秒级热更新**（不刷新页面、不丢弹窗和状态） |
| 不加班主题配色 / CSS 覆盖 | `assets/theme/tokens.css`、`assets/theme/shell.css`、`assets/theme/studio.css`、`brand/brand.json` | **原地热替换**（零刷新直接变色/改样式） |
| 壳叠加脚本（DOM 补丁） | `assets/shell-ui.js` | 自动通知工作台页面刷新 |
| DSH 侧栏 / 面板外框代码 | `src/studio/studio-panel.mjs`、`src/studio/studio-entry.js` | `esbuild` 自动重建 `client.js` |
| Host 后端逻辑（`.mjs`） | `src/**/*.mjs`、`index.js` | 脚手架自动 touch 模块图，右下角角标会提示「Host 源码已改，请重载插件」 |

> [!TIP]
> **Windows 注意**：文件监听只放在仓库目录（例如 `.upstream/openfilm`、`assets/`、`src/`）内，不要把源码或监听目录放到带 `~1` 短名的 `%TEMP%`（如 `ADMINI~1`）路径下。

---

## 第一步：一次性准备本地开发源码（只需做一次）

1. 在仓库根目录安装依赖：

```powershell
npm ci
```

2. 拉取与当前版本匹配的 OpenFilm 固定版本源码到 `.upstream/openfilm`：

```powershell
npm run upstream:fetch
```

---

## 第二步：一条命令开启实时热更新（边改边看）

### 1. 启动实时开发服务

打开终端 1，在仓库根目录执行：

```powershell
npm run dev:live
```

它会同时启动：
- **Vite Dev Server**（`http://127.0.0.1:47825`）：直接编译并提供 `.upstream/openfilm` 源码，开启 React Fast Refresh（HMR WebSocket 走 `/__dsh_vite_hmr`）；
- **主题 CSS 热监听**：监听 `assets/theme/*.css` 和 `brand/brand.json`；
- **客户端重建监听**：`esbuild` 监听 `src/studio/studio-entry.js` → 自动生成 `client.js`；
- **Host 模块变动提醒**：监听 `src/**/*.mjs`（如果原本已经有本地未提交修改，脚本会完整保留，不会覆盖）。

### 2. 用开发环境变量启动 DSH（启动即开放浏览器端口）

打开终端 2，设置好下面几个环境变量后再启动你的本机 DSH（DSH 是本插件必需的真实后端，不需要另造假后端）：

```powershell
$env:NO996_OPENFILM_DEV_HMR = "1"
$env:NO996_OPENFILM_VITE_ORIGIN = "http://127.0.0.1:47825"
# 可选：跳过工作台登录门，方便离线调样式
$env:NO996_OPENFILM_DEV = "1"
# 可选：开启样式拾取悬浮工具条（仅开发态可用，不进正式包）
$env:NO996_OPENFILM_STYLE_LAB = "1"
```

DSH 启动并预热 Studio 后（**无需先点左侧「视频创作」面板**），开发端口与内置面板同时就绪：
- **DSH 内置面板口**：`47822`（仅 DSH 客户端面板使用，保留严格鉴权）；
- **开发者永久开放口**：**`http://127.0.0.1:47821/`**（任何 Chrome、Playwright、DevTools 或**其它 AI Agent 的浏览器/内嵌 `<iframe>` 面板**直接打开即用！免登录、免 Cookie、免 60 秒 Ticket；老地址 `47821/editor` 会自动 `302` 到 `/`，误开 `:47825/` 也会自动跳过去不再白屏）。

页面右下角出现绿色角标 **`DEV HMR · 已连接`**，就说明热更新与实时样式链路全通了。

> 如果在虚拟机或网络盘下发现保存文件没有触发热更新，可以加轮询参数重启第一步：`npm run dev:live -- --poll`。

---

## 第三步：怎么调样式与改界面（完整日常流程）

### 场景 A：微调主题颜色、圆角、阴影或局部 CSS
1. 打开 `assets/theme/tokens.css`、`assets/theme/shell.css` 或 `assets/theme/studio.css`（或修改 `brand/brand.json`）。
2. 直接修改并 **Ctrl+S 保存**。
3. DSH 工作台会在几十毫秒内自动把新的 `<style data-no996-theme>` 替换进页面，右下角角标变为 **`DEV HMR · 样式热更新 HH:MM:SS`**，**页面不刷新、当前打开的项目和弹窗完全保留**。

### 场景 B：修改 OpenFilm React 组件、按钮、布局或文案
1. 用编辑器打开 `.upstream/openfilm/` 下的对应 `.tsx` / `.ts` / `.css` 文件（比如 `packages/openfilm/studio/ui/src/components/WorkbenchAccount.tsx`）。
2. 修改代码并 **Ctrl+S 保存**。
3. Vite 会通过 HMR WebSocket 把更新直接热替换到当前 React 组件里，界面立刻变成最新效果。
4. 如果你想先用可视化点选找元素选择器，启动前加 `$env:NO996_OPENFILM_STYLE_LAB = "1"`，页面左下角会出现「样式台」浮窗，点「点选元素」点击画面即可复制对应 DOM 选择器和 CSS 变量。

### 场景 C：修改了 `src/**/*.mjs`（Host 后端逻辑）
1. 修改并保存 `src/**/*.mjs`。
2. 右下角角标会变成黄色提示 **`DEV HMR · Host 源码已改，请重载插件`**。
3. 在 DSH 插件管理里点击重载本插件（若遇到模块缓存或提示需重启则重启 DSH）即可。

---

## 第四步：出了报错怎么看、怎么复制、怎么问 AI 诊断

系统在页面与宿主之间建了全链路结构化诊断日志（带 `traceId` 串联前后端）：

- **日志落盘位置**：`$DSH_HOME/no996-openfilm/logs/diagnostics-YYYY-MM-DD.jsonl`（默认自动保留 **14 天**、目录上限 **50 MiB**，启动与跨天自动清理过期文件）。
- **页面内入口（三个位置都能打开）**：
  1. 底部出现红色报错条时，直接点条上的 **「查看诊断日志」**；
  2. 工作台右上角账号条旁的 **小虫子图标（诊断日志按钮）**（有新报错会带红点提示）；
  3. **设置 → 开发者 → 打开日志中心**。
- **在「错误与诊断日志中心」里你可以直接做 4 件事**：
  1. **展开定位**：查看精确的 `location`（如 `src/native/dsh-native-agent-service.mjs:selectThinking`）、`traceId`、入参、允许列表与脱敏调用栈；
  2. **复制给开发者**：一键复制完整 Markdown 排障报告；
  3. **问 Agent 诊断**：点 **「填入当前对话问 Agent」** 直接填进右侧剪辑对话，或点 **「复制 Agent 提示词」** 贴给 DSH 主会话；
  4. **导出诊断包 / 清理日志**：导出脱敏 `.json` 诊断包发给别人，或在顶部调整保留天数（7 / 14 / 30 / 90 天）及手动清理。

---

## 第五步：改完以后，怎么打包成正式插件（开发工具绝对不进包）

在 `.upstream/openfilm/` 调试满意后，**必须**把源码改动固化回本仓库快照和补丁，再打包验证：

```powershell
# 1. 把 .upstream/openfilm 的最新构建生成正式界面快照
node scripts/build-official-shell.mjs F:\Dev\Desktop-Projects\dsh-no996-editor\.upstream\openfilm --output F:\Dev\Desktop-Projects\dsh-no996-editor\vendor\official-shell.next
# （确认无误后替换旧的 vendor/official-shell）

# 2. 把上游改动拆成逐文件补丁（patches/*.patch）
npm run patches:split

# 3. 把 assets/theme/*.css 烘焙进正式界面快照
npm run shell:bake

# 4. 跑全量检查（语法、单测、文档、品牌、模板、补丁一致性）
npm run check

# 5. 打「发给用户的正式包」到 dist/（彻底剔除开发文件并锁死 47821 工作台）
node scripts/pack-tgz.mjs

# （仅当你要把工作区打成“本地开发调试包”安装进本机 DSH 时，才显式加 --dev 输出到 .dev/，绝不会进 dist/）
# node scripts/pack-tgz.mjs --dev
```

> [!IMPORTANT]
> **给用户的包 vs 开发者本地包三级硬隔离**：
> 1. **物理剔除**：默认 `pack-tgz.mjs` 打包出的正式 `.tgz` **物理不存在** `src/dev/`、`assets/style-lab.js`、`scripts/`、`patches/` 等开发文件；
> 2. **包内指纹**：正式 `.tgz` 会在包内 `package.json` 自动打上 `dsh.releaseBuild = true`（`--dev` 调试包不会写入且只输出到 `.dev/`）；
> 3. **运行时锁死**：哪怕用户端强行设置了 `NO996_OPENFILM_DEV=1` / `DEV_HMR=1` / `OPEN_BROWSER=1`，正式包检测到 `releaseBuild === true` 或缺少 `src/dev/` 时也会全部忽略，`:47821/` 与 `:47821/editor` 一律返回 `404`，绝不暴露开发者入口。
