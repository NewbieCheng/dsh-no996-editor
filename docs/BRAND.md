<!-- doc
id: brand
reader: 产品 / 设计 / 维护者
fact-source: brand/brand.json、assets/theme/*.css
checked: 0.22.0
rot-if: 品牌字段、法务要求或替换流程变化
-->

# 品牌层（不加班剪辑 / No996 Studio）

> 品牌数据集中维护，但并非所有界面都由同一文件生成；更名时须逐处核验，并**保留上游版权与商标声明**。

---

## 1. 唯一事实来源

`brand/brand.json`：

| 字段 | 用途 |
|---|---|
| `name` / `nameEn` | 界面标题、关于页、安装说明 |
| `slug` | 内部标识（未来用于目录名、更新通道） |
| `vendor` | 版权行 |
| `tagline` | 登录页/空态文案 |
| `colors.*` | 生成 `--n996-*` CSS 变量（accent / accentDeep / paper / ink / night） |
| `links.*` | 帮助、官网、反馈入口 |
| `upstream.*` | 上游名称、版本、许可证、归属声明（**只读，不许删**） |

`src/ui/brand.mjs` 负责校验与导出：

- 名字 1–24 字符，slug 必须是小写 kebab-case；
- 颜色必须是 `#rrggbb`，缺 `accent/paper/ink` 直接报 `BRAND_INVALID`；
- 缺 `upstream` 直接拒绝——**改名不能把归属改没**。

---

## 2. 消费方

| 界面 | 现在读什么 | 状态 |
|---|---|---|
| 主题颜色 | `brandCssVars()` → `--n996-*` | 已接（`src/ui/theme.mjs`） |
| 页面标题（tab / 历史） | 代理把上游 `<title>` 换成 `brand.name` | 已接（`replaceTitle`） |
| 面板标题 / 侧栏名 | `locale/*.json`（当前已是品牌名） | 文案已改；尚未从 brand 生成 |
| 官方壳的标题/文案 | 上游 i18n + 源码补丁 | 不保证全部从 brand 生成 |
| 登录页 | 上游壳 `LoginGate.tsx` 补丁；`assets/shell-login.js` 是参考实现 | 改动时核对两者，真机验收 |
| 关于/版本 | 面板「关于」 | 核对源码与实际页面，不假定与 brand 同步 |
| 安装包/README | `package.json`、`README.md` | npm 包名是独立身份，改品牌不自动改包名 |

**原则：** 品牌是数据，不是散落在模板字符串里的常量。新增界面时先问"这里的名字从哪来"，答不上来就不许硬编码。

---

## 3. 改品牌（五步）

1. 改 `brand/brand.json`（名字、颜色、链接）。
2. 跑 `npm run brand:check`（字段合法、主题文件在位、locale 里没有残留的上游品牌）。
3. `npm run build`（如果改了客户端源码）+ 刷新页面。
4. 看一眼：登录页、壳标题、面板标题、关于页、空态文案。
5. 更新 `README.md` 的产品名与截图说明；`CHANGELOG.md` 记一条。

图标：`icon.svg` 与 `assets/logo-symbol-*.svg` 是资源文件，替换时保持文件名不变，避免同时改构建配置。

---

## 3.1 用户品牌记忆（0.22.0）

`brand/brand.json` 仍是**产品自身**的品牌事实；用户给影片设置的 Logo／名称／写作身份是另一层数据，存在 DSH `storageDomain` 的 `no996_brand_memory`，不写回产品品牌文件。

- 唯一入口：工作台「设置 → 全局资产 → 品牌」。账号与余额在右上角「我的工作台」里，与本机全局资产分开；游客也能配置本机品牌，登录不会改变它。
- 左编辑右预览：名称、上传或拖入 Logo、展示方式（Logo＋名称／单 Logo）、默认位置；右侧按横竖屏和深浅底即时预览，虚线是安全区。窄窗口自动改上下排列。
- 上传接受 PNG／JPG／WebP（≤20 MB），在浏览器内按原比例缩放压缩成 PNG（≤2 MB）；横长 Logo 不会被裁成方形。不压缩成正方形，也不上传到任何服务器。
- 首次在项目页显示一次「添加你的品牌 Logo」提示，可去配置或暂不设置；两种情况都不再重复出现。聊天框没有品牌入口。
- 影片显式选用时，把 Logo、名称、写作身份、位置快照到项目 `.film/brand.json`，Logo 存为 `assets/brand/<sha256>.png`；`Logo＋名称` 另生成本地页面 `assets/brand/lockup-<sha256>.html`，其中 Logo 与名称是两个独立可编辑元素。以后改全局设置不会改变旧影片。
- 位置优先级：本片位置 > profile 默认位置 > 竖屏左上／横屏右下；`自动` 记为 `placementMode: auto`，手动选角后固定。
- 画面只读取名称、位置和素材引用；写作身份只通过 `no996_brand`（`purpose: narration|on-screen-copy`）按需读取。`purpose: placement` 只返回品牌素材引用与位置规则，供用户明确要求摆放时参考，不返回写作身份。
- 分享配方默认移除品牌和 Logo；应用自己写入的品牌成片镜头不会被当作可复用模板镜头提取。


## 4. brand:check 检查什么

- `brand.json` 通过 `validateBrand`；
- `assets/theme/{tokens,shell,studio}.css` 存在且使用 `--n996-*` 变量；
- `locale/*.json` 的**值**里不出现上游产品名（键名与注释不算）；
- `brand.upstream` 四项齐全（名称/版本/许可证/声明）。

它**不**检查 README/CHANGELOG 里的上游提及——那些是合法的归属说明。

---

## 5. 法务边界（别越线）

- 上游是 MIT：可以修改、可以分发、可以商用；**必须保留版权声明与许可证文本**（`vendor/official-shell/source/LICENSE`、`vendor/LICENSE`）。
- 上游的 `TRADEMARK.md` 仍然有效：不能用 OpenFilm 的名字/标识暗示官方背书，不能把他们的商标注册成我们的。
- 我们的产品名与标识是独立的；界面里可以写"基于 OpenFilm 构建"，但不能写"OpenFilm 官方"。
- 第三方依赖（React / Inter / Lexical 等）的完整许可文本发布前要补齐；现在 `THIRD_PARTY_NOTICES.md` 很短，这是已知缺口，不是"已解决"。

---

## 6. 不要做

- 不要在代码里硬编码"不加班剪辑"或 `#ff6400`；一律走 `brand` / CSS 变量。
- 不要为了"看起来像自己的产品"删掉 `upstream` 字段或许可证文件。
- 不要把 `package.json` 的 `name` 改成产品名——那是 npm 包身份，改了会破坏已安装链接与更新路径。
- 不要在登录页/引导页里写死版本号；版本从 `package.json` 与 manifest 读。
