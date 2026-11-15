<!-- doc
id: index
reader: 所有人（第一次进仓库）
fact-source: 本目录下的文件清单
checked: 0.15.22
rot-if: 新增/删除 docs/ 下的顶层文档
-->

# 文档索引

> 文档按**用途**分，不按主题堆。一条原则：**只有一篇写进度，其余只写"怎么用"和"为什么"。**
> 已实现的东西不写进文档（看 `CHANGELOG.md`）；待做的事只写一句结论（看 [`STATE.md`](STATE.md)）。

## 1. 六篇必读

| 文档 | 谁读 | 回答什么问题 |
|---|---|---|
| [`../README.md`](../README.md) | 所有人 | 这是什么、怎么装、能干什么、不干什么 |
| [`../AGENTS.md`](../AGENTS.md) | 智能体 | 红线、改哪一层、对话边界、生效矩阵、证据入口 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 开发者 | 进程模型、会话边界、注入链、数据在哪 |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | 开发者 | 跑起来、构建、改完怎么生效 |
| [`STATE.md`](STATE.md) | 所有人 | **唯一写进度的一篇**：当前版本、能用、待验、不做 |
| [`TEMPLATES.md`](TEMPLATES.md) | 做模板的人 | 模板结构、构建、**模板提示词怎么注入** |

## 2. 按任务找

| 你要 | 读 |
|---|---|
| 改界面（L1/L2） | [`reference/ui-layers.md`](reference/ui-layers.md) → [`playbooks/ui-change.md`](playbooks/ui-change.md) → [`reference/injection-registry.md`](reference/injection-registry.md) |
| 升上游 OpenFilm | [`playbooks/upstream-bump.md`](playbooks/upstream-bump.md) |
| 发版 | [`playbooks/release.md`](playbooks/release.md) |
| 排障 | [`playbooks/incident.md`](playbooks/incident.md)（症状 → 根因 → 现在靠什么挡住） |
| 做画面/动效 | [`MOTION.md`](MOTION.md) + skill `openfilm-motion` |
| 剪片语法 | skill `openfilm-editing` |
| 口播转写 | [`TRANSCRIBE.md`](TRANSCRIBE.md) |
| 对话行为、提示词注入 | [`topics/agent-plan.md`](topics/agent-plan.md) + [ADR-0011](decisions/ADR-0011-director-contract.md) |
| 品牌/法务 | [`BRAND.md`](BRAND.md) |
| DSH 外壳改造案例 | [`DSH-SHELL-INTEGRATION.md`](DSH-SHELL-INTEGRATION.md) |

参考（可以生成、随代码变）：[`reference/`](reference/)（路由、环境变量、模块、模板与风格清单、存储、安全、界面层）。

## 3. 每篇的属性块

```html
<!-- doc
id: 唯一 id（等于文件名）
reader: 谁读
fact-source: 这些事实来自哪（源码路径 / 生成脚本 / 上游）
checked: 最后核对时的版本（等于 package.json，或 `generated`）
rot-if: 什么变了这篇就该重写
-->
```

`docs:check` 强制这个块、死链、以及"进度措辞只能出现在 `STATE.md`"。

## 4. 新增一篇之前

先问三个问题：它属于**怎么用**（放 playbooks/）、**为什么**（放 decisions/，只追加）、还是**可以生成的事实**（放 reference/，用脚本生成）？
三样都不是，才放 `topics/`。写完在上一节的表里加一行；没有读者的文档不要加。
