<!-- doc
id: reference-modules
reader: 接手代码的人、reviewer
fact-source: src/*.mjs、index.js 的文件与 export 扫描（scripts/gen-docs.mjs 生成）
checked: generated
rot-if: 新增/删除模块或测试（重新生成即可）
-->

# 模块清单（自动生成）

> 生成命令：`npm run docs:gen`。119 个模块、18891 行。
> 没有测试直接 import 的模块：15 个（待补清单，不是失败项）；另有 1 个已登记排除。
> "测试"列 = 直接 import 该模块的测试文件，来自 `tests/**` 的实际 import 语句，不做名字猜测。
> 排除项写在 `scripts/test-exclusions.json`，每条必须带理由。

| 模块 | 行数 | 导出 | 同名测试 |
|---|---|---|---|
| `src/studio/studio-controller.mjs` | 1333 | createStudioController | 读源码：`declaration-order.test.mjs`、`route-registration-order.test.mjs`、`sidebar-untouched.test.mjs`、`system-routes.test.mjs` |
| `src/native/dsh-native-agent-service.mjs` | 1254 | createDshNativeAgentService | `dsh-native-agent-service.test.mjs` |
| `src/ui/sidebar-editing.mjs` | 1132 | EDITING_LABEL, installWorkspaceSwitch | `sidebar-editing-rows.test.mjs` |
| `src/studio/studio-proxy.mjs` | 879 | startStudioProxy | `proxy-error-sanitize.test.mjs`、`studio-proxy-files.test.mjs`、`theme-injection.test.mjs` |
| `src/official/official-facade.mjs` | 613 | officialFacadeSource | `facade-page.test.mjs`、`official-attachment.test.mjs`、`official-facade-events.test.mjs` |
| `src/native/no996-llm-provider.mjs` | 543 | createNo996LlmAdapter, registerNo996LlmProvider | `no996-llm-provider.test.mjs` |
| `src/auth/workbench-auth.mjs` | 461 | DEFAULT_WORKBENCH_BASE_URL, createWorkbenchAuth, parseAuthActionBody | `dev-mode.test.mjs`、`workbench-auth-jwt-session.test.mjs`、`workbench-auth.test.mjs` |
| `src/studio/studio-panel.mjs` | 375 | createStudioPanel, templateProjectUrl | `template-bridge.test.mjs`、`template-panel.test.mjs` |
| `src/voice/voice-bridge.mjs` | 351 | VOICE_BRIDGE, createVoiceBridge, installVoiceBridgeGlobal | `voice-bridge.test.mjs` |
| `src/studio/studio-controller/routes/editing.mjs` | 322 | createEditingRoutes | `editing-routes.test.mjs` |
| `src/tools/tool-installer.mjs` | 296 | TOOL_SOURCES, createToolInstaller, readTarMember | `tool-installer.test.mjs` |
| `src/media/no996-studio-bridge.mjs` | 293 | VOICE_BRIDGE, createNo996StudioBridge | `no996-studio-bridge.test.mjs` |
| `src/host/preferences.mjs` | 263 | balanceCachePatch, balanceFromPrefs, clearBalanceCachePatch, createPreferencesStore, onboardingCopy, productMeta | `preferences-custom.test.mjs`、`preferences.test.mjs` |
| `src/asr/transcribe-service.mjs` | 255 | CACHE_VERSION, createTranscribeService, fingerprint | **无** |
| `src/official/official-permission.mjs` | 249 | FULL_ACCESS, PROJECT_PERMISSIONS_DOMAIN, WORKSPACE_WRITE, openProjectPermissions | `official-permission.test.mjs` |
| `src/studio/studio-entry.js` | 226 | — | 读源码：`panel-keepalive.test.mjs`、`sidebar-untouched.test.mjs`、`template-panel.test.mjs` |
| `src/ui/client-entry.js` | 197 | — | 排除：浏览器端打包入口；运行时界面行为需要客户端集成或真机验收 |
| `src/asr/asr-models.mjs` | 192 | SENSE_VOICE, ensureModels, libraryCacheRoot, modelState, modelsRoot, senseVoiceDir… | `asr-models.test.mjs` |
| `src/film/script-plan.mjs` | 186 | planFromTranscript, sentencesFromSegments, shotsFromScript, storyboardFromPlan, subtitlesFromScript, toSrt… | `storyboard.test.mjs` |
| `src/host/fallback-prompt.mjs` | 185 | buildFallbackPayload, createFallbackPrompt | `fallback-prompt.test.mjs` |
| `src/official/official-chat-store.mjs` | 181 | OFFICIAL_CHAT_DOMAIN, OFFICIAL_CHAT_MAX_BYTES, openOfficialChatStore | `official-chat-store-delete.test.mjs` |
| `src/tools/cli-tool.mjs` | 180 | cliArguments, createCliTool, resolveCli | `export-cli-tool.test.mjs`、`tool-schema.test.mjs` |
| `src/film/storyboard.mjs` | 176 | KINDS, MOTIONS, STORYBOARD_FILE, VERSION, normalizeStoryboard, planFromStoryboard… | `storyboard.test.mjs` |
| `src/tools/transcribe-tool.mjs` | 176 | createTranscribeTool | `transcribe-tool.test.mjs` |
| `src/studio/studio-runtime.mjs` | 173 | OPENFILM_VERSION, createStudioRuntime, loadPinnedStudio | `studio-runtime.test.mjs` |
| `src/ui/sidebar-brand.mjs` | 172 | brandSvgMarkup, findSidebarBrandSlot, installSidebarBrand | `sidebar-brand.test.mjs` |
| `src/studio/studio-debug-redirect.mjs` | 168 | startLocalConsole | `studio-debug-redirect.test.mjs` |
| `src/native/no996-web-provider.mjs` | 167 | createNo996WebProviders, registerNo996WebProvider | `no996-web-provider.test.mjs` |
| `src/tools/clip-tool.mjs` | 167 | MAX_CLIP_BYTES, MAX_CLIP_OPERATIONS, createClipTool, filmIdentity | `clip-tool.test.mjs`、`tool-schema.test.mjs` |
| `src/native/dsh-session-store.mjs` | 164 | createDshSessionStore | `dsh-native-agent-service.test.mjs`、`dsh-session-store-selection.test.mjs` |
| `src/studio/studio-debug.mjs` | 162 | redeemStudioSession, startStudioDebug | `studio-debug-theme.test.mjs` |
| `src/tools/frame-tool.mjs` | 162 | createFrameTool | `studio-tools.test.mjs`、`tool-schema.test.mjs` |
| `src/project/project-files.mjs` | 161 | PROJECT_ID, createProjectFiles, openCommand, projectFileError, projectFilePath, relativeProjectPath | `project-files.test.mjs` |
| `src/official/official-templates.mjs` | 157 | installTemplate, listTemplates | `official-templates.test.mjs`、`template-registration.test.mjs` |
| `src/asr/asr-pipeline.mjs` | 156 | TRANSCRIBE_LIMITS, assembleTranscript, createTranscribePipeline | `asr-pipeline.test.mjs` |
| `src/official/official-chat-rpc.mjs` | 154 | createOfficialChatRpc | `official-chat-rpc.test.mjs` |
| `src/ui/env-section.mjs` | 153 | createEnvSection | **无** |
| `src/tools/storyboard-tool.mjs` | 147 | createStoryboardTool | `storyboard.test.mjs` |
| `src/film/timeline-operations.mjs` | 142 | TimelineEditError, applyTimelineOperations | `timeline-operations.test.mjs` |
| `src/auth/auth-bridge.mjs` | 141 | dispatchAuthAction, registerAuthBridge | `workbench-auth.test.mjs` |
| `src/asr/asr-audio.mjs` | 140 | TARGET, extractPcm, parseProbeOutput, probeMedia, resolveFfmpeg, runFfmpeg | `asr-audio.test.mjs`、`asr-media.test.mjs` |
| `src/film/template-prompts.mjs` | 134 | BLOCK_BEGIN, BLOCK_END, BLOCK_MAX, PROMPT_MAX, TEMPLATES_FILE, readActiveTemplates… | `template-prompts.test.mjs` |
| `src/project/workspace-archive.mjs` | 131 | createArchiveWatcher | `workspace-archive.test.mjs` |
| `src/studio/studio-controller/routes/environment.mjs` | 130 | createEnvironmentRoute | `environment-route.test.mjs` |
| `src/auth/login-remember.mjs` | 124 | createLoginRememberStore | `login-remember.test.mjs` |
| `src/asr/asr-wav.mjs` | 123 | openWav, parseWavHeader | `asr-wav.test.mjs` |
| `src/asr/asr-silence.mjs` | 119 | createSilenceSegmenter, findSpeechRuns, percentile, rmsOf | `asr-silence.test.mjs` |
| `src/official/official-approvals.mjs` | 118 | createOfficialApprovals | **无** |
| `src/project/editing-prefs.mjs` | 118 | createEditingPrefs | `editing-prefs.test.mjs` |
| `src/tools/film-tool.mjs` | 118 | createFilmTool, exportReadiness, summarizeFilm | `studio-tools.test.mjs`、`tool-schema.test.mjs` |
| `src/film/film-draft.mjs` | 116 | draftFilm | `draft-session.test.mjs`、`film-draft.test.mjs` |
| `src/host/plugin-log.mjs` | 116 | createPluginLog, redact | `plugin-log.test.mjs` |
| `src/tools/export-tool.mjs` | 115 | blockedBy, createExportTool, exportAsk | `export-cli-tool.test.mjs`、`tool-schema.test.mjs` |
| `src/official/official-event-stream.mjs` | 113 | attachOfficialEventStream | `official-event-stream.test.mjs` |
| `src/voice/install-no996-provider.mjs` | 113 | installNo996Provider, openfilmPresent, preferNo996Defaults, preferNo996ForTts, resolveSharedHome | `no996-studio-bridge.test.mjs`、`voice-bridge.test.mjs` |
| `src/asr/asr-text.mjs` | 112 | countChars, formatTimecode, ribbonTimes, round3, splitSentences, textWeight… | `asr-text.test.mjs` |
| `src/studio/studio-controller/routes/diagnose.mjs` | 107 | createDiagnoseRoute | `diagnose-route.test.mjs` |
| `src/studio/studio-controller/routes/system.mjs` | 107 | createSystemRoutes | 读源码：`system-routes.test.mjs` |
| `src/studio/drop-catcher.mjs` | 106 | installDropCatcher | `drop-catcher.test.mjs` |
| `src/tools/library-tool.mjs` | 106 | LIBRARY_KINDS, createLibraryTool | `studio-tools.test.mjs`、`template-prompts.test.mjs`、`tool-schema.test.mjs` |
| `src/tools/assets-tool.mjs` | 105 | createAssetsTool, flattenFiles | `assets-tool.test.mjs`、`tool-schema.test.mjs` |
| `src/studio/studio-library-mirror.mjs` | 104 | SENSE_VOICE_PATHS, ensureStudioLibraryMirror | `studio-library-mirror.test.mjs` |
| `src/host/download-stall.mjs` | 103 | DEFAULT_CONNECT_MS, DEFAULT_IDLE_MS, createStallWatch, linkSignals, stallReason | `download-stall.test.mjs` |
| `src/studio/studio-proxy/upstream.mjs` | 103 | COMMAND_FAILURE, RESPONSE_HEADERS, SAFE_HEADERS, ancestorsFor, fail, friendlyCommandFailure… | **无** |
| `src/native/instruction-inventory.mjs` | 100 | headOf, instructionChain, projectRootOf | `agent-overlays.test.mjs` |
| `src/project/project-instructions.mjs` | 100 | INSTRUCTIONS, ensureProjectInstructions, upgradeProjectInstructions | `project-instructions.test.mjs` |
| `src/host/bridge-trace.mjs` | 99 | createBridgeTrace | `bridge-trace.test.mjs` |
| `src/studio/studio-http.mjs` | 98 | createStudioHttp | `studio-http.test.mjs` |
| `src/host/host-components.mjs` | 96 | createHostComponentDetector | `host-components.test.mjs` |
| `src/ui/brand.mjs` | 96 | brandCssVars, brandVersion, getBrand, replaceTitle, validateBrand | `brand.test.mjs` |
| `src/asr/asr-segments.mjs` | 95 | SEGMENT_LIMITS, normalizeSegments, planSegments | `asr-segments.test.mjs` |
| `src/native/dsh-event-map.mjs` | 90 | convertToolContent, mapToolCallForUi, parseToolArgs | **无** |
| `src/asr/asr-sensevoice.mjs` | 89 | createSenseVoiceRecognizer, loadSherpa | **无** |
| `src/host/download-sources.mjs` | 89 | MODEL_BASES, MODEL_REPO, TOOL_SOURCES, augmentPath, knownBinaryDirs, modelBases… | `download-sources.test.mjs` |
| `src/tools/get-tool.mjs` | 87 | createGetTool | `studio-tools.test.mjs`、`tool-schema.test.mjs` |
| `src/studio/studio-controller/turns.mjs` | 84 | createTurnLog | `turn-log.test.mjs` |
| `src/tools/image-gen-tool.mjs` | 82 | createImageGenTool | **无** |
| `src/ui/theme.mjs` | 82 | THEME_SURFACES, createTheme, theme, themeSurfaceFor | `theme.test.mjs` |
| `src/host/preset-report.mjs` | 80 | reportPresetStatus | `preset-report.test.mjs` |
| `src/film/template-catalog.mjs` | 79 | catalogText, scoreTemplate, searchTemplates, templateCatalog | `storyboard.test.mjs` |
| `src/project/project-trash.mjs` | 79 | TRASH_DIR, createProjectTrash | `project-trash.test.mjs` |
| `src/studio/studio-controller/routes/diagnostics.mjs` | 79 | createDiagnosticsRoutes | `client-log-route.test.mjs`、`drag-probe-route.test.mjs` |
| `src/studio/studio-controller/routes/bootstrap.mjs` | 76 | createBootstrapRoute | `bootstrap-route.test.mjs` |
| `src/host/area-bus.mjs` | 74 | areaBus, createAreaBus | **无** |
| `src/film/timeline-layout.mjs` | 71 | layoutTimeline | `timeline-layout.test.mjs` |
| `src/asr/asr-refine.mjs` | 65 | REFINE_REASONS, buildRefinePrompt, parseRefineReply, refineTranscript | `asr-refine.test.mjs` |
| `src/film/film-summary.mjs` | 65 | summarizeFilm | `film-summary.test.mjs`、`timeline-layout.test.mjs` |
| `src/studio/studio-library-patch.mjs` | 64 | SENSE_VOICE_ABOUT, SENSE_VOICE_ID, SENSE_VOICE_MODEL, applyStudioLibraryPatch | `studio-library-patch.test.mjs` |
| `src/host/chat-trace.mjs` | 63 | createChatTrace, describeEvent | `chat-trace.test.mjs` |
| `src/project/editing-filter.mjs` | 60 | SESSION_FALLBACK, filterEditing, matchRange, normalizeQuery, projectDisplayTitle, sessionDisplayTitle | `editing-filter.test.mjs` |
| `src/project/archive-bridge.mjs` | 59 | registerArchiveBridge | **无** |
| `src/studio/studio-controller/routes/debug-url.mjs` | 58 | createDebugUrlRoute | `debug-url-route.test.mjs` |
| `src/studio/studio-proxy/websocket.mjs` | 58 | MAX_FRAME, WS_GUID, frames, wsFrame | **无** |
| `src/native/openfilm-skills.mjs` | 55 | apply, inject | `openfilm-skills-plugin.test.mjs` |
| `src/studio/drag-probe.mjs` | 54 | installDragProbe | `drag-probe.test.mjs` |
| `index.js` | 53 | apply, inject | 读源码：`lint.test.mjs`、`release-check.test.mjs` |
| `src/ui/shell-extras.mjs` | 52 | shellUiInjection, shellUiVersion | `shell-extras.test.mjs`、`shell-ui-asi.test.mjs` |
| `src/native/openfilm-prompt.mjs` | 51 | apply, inject | `pinned-scope-integration.test.mjs` |
| `src/film/template-bridge.mjs` | 50 | registerTemplateBridge | `template-bridge.test.mjs` |
| `src/studio/studio-controller/router.mjs` | 47 | createRouter | `route-registration-order.test.mjs` |
| `src/project/editing-project-delete.mjs` | 44 | createEditingProjectDelete | `editing-project-delete.test.mjs` |
| `src/official/official-event-hub.mjs` | 43 | createOfficialEventHub | `official-event-stream.test.mjs` |
| `src/official/official-shell.mjs` | 40 | resolveOfficialShell | **无** |
| `src/tools/draft-tool.mjs` | 38 | createDraftTool | `draft-tool.test.mjs`、`tool-schema.test.mjs` |
| `src/studio/studio-controller/routes/assets.mjs` | 37 | createAssetRoutes | **无** |
| `src/studio/panel-keepalive.mjs` | 36 | createActivationStore | `panel-keepalive.test.mjs` |
| `src/ui/style-lab.mjs` | 36 | styleLabInjection, styleLabVersion | `style-lab.test.mjs` |
| `src/asr/asr-media.mjs` | 34 | createMediaEdge | `asr-media.test.mjs` |
| `src/official/official-model-catalog.mjs` | 34 | officialModelOptions | **无** |
| `src/tools/guide-tool.mjs` | 34 | createGuideTool | `tool-schema.test.mjs` |
| `src/host/dsh-ai.mjs` | 29 | createDshAskAgent | **无** |
| `src/project/editing-sessions.mjs` | 29 | buildEditingProjects | `editing-sessions.test.mjs` |
| `src/host/elevation.mjs` | 26 | createElevationProbe | `elevation.test.mjs` |
| `src/host/host-paths.mjs` | 25 | installHostPathBridge | `host-paths.test.mjs` |
| `src/film/draft-session.mjs` | 24 | MAX_DRAFT_OPERATIONS, appendDraft, startDraft, undoDraft | `draft-session.test.mjs` |
| `src/official/official-attachment.mjs` | 20 | officialUploadSource | `official-attachment.test.mjs` |
| `src/studio/studio-controller/http-body.mjs` | 15 | readJsonBody | **无** |
| `src/native/openfilm-persona.mjs` | 12 | PERSONA, ROOT_MARKERS | `agent-overlays.test.mjs` |
| `src/film/film-source.mjs` | 11 | MAX_SOURCE_BYTES, decodeFilmSource | `film-draft.test.mjs`、`film-source.test.mjs` |

## 没有测试直接 import 的模块

- `src/asr/transcribe-service.mjs`（255 行）
- `src/ui/env-section.mjs`（153 行）
- `src/official/official-approvals.mjs`（118 行）
- `src/studio/studio-proxy/upstream.mjs`（103 行）
- `src/native/dsh-event-map.mjs`（90 行）
- `src/asr/asr-sensevoice.mjs`（89 行）
- `src/tools/image-gen-tool.mjs`（82 行）
- `src/host/area-bus.mjs`（74 行）
- `src/project/archive-bridge.mjs`（59 行）
- `src/studio/studio-proxy/websocket.mjs`（58 行）
- `src/official/official-shell.mjs`（40 行）
- `src/studio/studio-controller/routes/assets.mjs`（37 行）
- `src/official/official-model-catalog.mjs`（34 行）
- `src/host/dsh-ai.mjs`（29 行）
- `src/studio/studio-controller/http-body.mjs`（15 行）

## 已登记排除

- `src/ui/client-entry.js`：浏览器端打包入口；运行时界面行为需要客户端集成或真机验收

