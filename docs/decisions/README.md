<!-- doc
id: decisions
reader: 维护者、要推翻某个设计的人
fact-source: docs/decisions/README.md 的历史条目（已迁入）、CHANGELOG、源码
checked: 0.19.0
rot-if: 新增或废弃一条 ADR
-->

# 决策记录（ADR）

> 一条决策一个文件，**只追加不修改**。正文保留当时的事实和取舍，`checked: historical` 不代表已经按当前版本逐项复核；现状与状态以本索引、源码及当前手册为准。要推翻某条，写新的 ADR 并标注 `Supersedes:`。
> 判据：这个决定错了会让谁付出什么代价？写不出代价的，不是决策，是偏好。

## 索引

| ADR | 决定 | 状态 | 代价 |
|---|---|---|---|
| [0001](ADR-0001-repo-boundary.md) | 独立仓分发，不做工作台分支 | 生效 | 两边代码不共享 |
| [0002](ADR-0002-panel-overlay.md) | 面板挂 `shell.overlay` 常驻，`main` 只放占位 | 生效 | 自己同步矩形与生命周期 |
| [0004](ADR-0004-upstream-patches.md) | 上游用构建快照 + 按文件拆的可重放补丁 | 生效 | 每次升级要重放整条补丁系列 |
| [0006](ADR-0006-narrow-sidebar-injection.md) | 侧栏只做一处窄注入，不占 single 槽 | 生效 | 依赖 DSH DOM 结构 |
| [0007](ADR-0007-docs-and-baseline.md) | 文档按寿命分层 + 工程基线进 CI | 生效 | 每次事实变化要重生成 |
| [0009](ADR-0009-ui-change-strategy.md) | 界面改动先改源码（补丁 + 重建），注入降级为例外并逐个迁出 | 生效 | 每次升上游要重放补丁、重建快照 |

## 模板

```markdown
<!-- doc
id: ADR-00NN-短名
reader: 维护者
fact-source: 源码路径 / 真机日志 / 上游 commit
checked: <版本>
rot-if: <什么变了这条决定就失效>
-->

# ADR-00NN：决定的一句话

- 状态：提议 / 生效 / 已被 ADR-00MM 取代
- 日期：YYYY-MM-DD
- 取代：无 / ADR-00MM

## 背景
当时面对什么约束，有哪几个选项。

## 决定
选了什么，边界在哪（明确不做什么）。

## 代价
为这个决定必须长期忍受什么。写不出来的，回去重写。

## 证据
源码路径、真机日志、测试名。让下一个人能自己复核。
```

## 哪些不该进 ADR

- 一次性的 bug 修复（进 `playbooks/incident.md` 或 CHANGELOG）；
- 纯风格偏好（进 `.editorconfig` / lint）；
- 还会变的进度（只进 `STATE.md`）。
