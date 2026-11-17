<!-- doc
id: reference-env-vars
reader: 部署者、排查问题的人
fact-source: src/*.mjs、index.js 里的 process.env 读取（scripts/gen-docs.mjs 生成）
checked: generated
rot-if: 新增/删除环境变量（重新生成即可）
-->

# 环境变量（自动生成）

> 生成命令：`npm run docs:gen`。共 **9** 个。表格只列"代码读了什么"，用途以 AGENTS.md §6 与各模块注释为准。

| 变量 | 读取次数 | 位置 |
|---|---|---|
| `DSH_HOME` | 10 | `src/auth/login-remember.mjs`、`src/auth/workbench-auth.mjs`、`src/host/preferences.mjs`、`src/studio/studio-controller.mjs`、`src/studio/studio-controller/routes/assets.mjs`、`src/tools/tool-installer.mjs` |
| `NO996_OPENFILM_CLI` | 1 | `src/tools/cli-tool.mjs` |
| `NO996_OPENFILM_DEBUG_PORT` | 3 | `src/studio/studio-controller.mjs`、`src/studio/studio-debug-redirect.mjs`、`src/studio/studio-debug.mjs` |
| `NO996_OPENFILM_DEV` | 2 | `src/auth/workbench-auth.mjs`、`src/studio/studio-controller.mjs` |
| `NO996_OPENFILM_DSH_CHAT` | 1 | `index.js` |
| `NO996_OPENFILM_EDITOR_PORT` | 2 | `src/studio/studio-controller.mjs`、`src/studio/studio-proxy.mjs` |
| `NO996_WORKBENCH_BASE_URL` | 1 | `src/auth/workbench-auth.mjs` |
| `OPENFILM_LIBRARY_URL` | 1 | `src/studio/studio-runtime.mjs` |
| `OPENFILM_NO_UPDATE_CHECK` | 2 | `src/studio/studio-runtime.mjs` |

