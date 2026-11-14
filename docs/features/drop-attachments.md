<!-- doc
id: features-drop-attachments
reader: 改对话区投放、或排查"拖不进去"的人
fact-source: src/host-paths.mjs、assets/shell-ui.js、patches/010-App.patch、patches/070-ProjectStarters.patch、patches/180-desktop-attachments.patch
checked: 0.15.10
rot-if: 官方 attachFiles / describePaths 形状变化、或 DSH 的 __DSH_HOST_PATHS__ 桥改名
-->

# 拖文件进对话

从资源管理器把视频/图片/文件夹拖进右侧对话：整页都能接，不再只有输入框那张卡片。

## 为什么以前只有输入框能接

官方对话页只在编辑器的卡片上挂了 `onDragOver` / `onDrop`（`App.tsx`）。
其余区域——包括空态那句"素材丢这里，我会放进项目素材库"的虚线框（`ProjectStarters.tsx`，
当时只是静态文本）——没有 handler，浏览器默认显示"禁止"光标。

两个 A1 补丁：

| 补丁 | 作用 |
|---|---|
| `010-App.patch` | 在页面级挂 `dragover`/`dragleave`/`drop`，文件交给同一个 `attachFiles`；拖入时整页高亮"松手即可附上" |
| `070-ProjectStarters.patch` | 虚线框变成真正的投放区（点击也能选文件） |

输入框本身的 handler 仍然优先（它知道光标位置）：卡片处理过的 drop 不再重复处理。

## 文件路径从哪来

- 官方桌面端：`window.openfilmDesktop.pathForFile`（Electron `webUtils`）。
- 我们的壳：对话页在 Studio 代理的 iframe 里，**跨源拿不到桌面桥**。所以：

```
对话页 (iframe)                     DSH 页面
  File ──postMessage──►  src/host-paths.mjs（监听）
                       ◄──path──   window.__DSH_HOST_PATHS__.pathFor(file)
```

`assets/shell-ui.js` 里的 `window.__no996HostPath` 发问（2 秒超时），拿不到路径就回落到
"无路径"分支：把内容存进项目的 `.film/attachments/`（和粘贴一样）。

所以：**有路径就只引用、不复制；没有路径就复制入库**。大视频建议路径分支命中（同一台机器、
文件没被删时都会命中）。

## 边界

- 文件夹也能拖：走 `describePaths` 的目录分支，只命名路径。
- 跨源 iframe 传 `File` 依赖结构化克隆；克隆体的桌面桥查不到路径时就是上面说的回落。
- 拖放不校验文件类型——和官方一致，能否用由 Agent 判断；大文件复制分支会慢。
