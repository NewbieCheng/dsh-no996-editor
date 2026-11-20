/**
 * Session-scoped 4-tier work mode state machine for OpenFilm conversations.
 *
 * Keeps ONE stable DSH agent preset (`openfilm-video-editing`) so tool/skill isolation
 * and conversation context are never torn down across mode transitions. The Host
 * owns mode state per `(projectId, conversation)`, renders a scoped model context,
 * and pushes live `mode_update` SSE frames when the user or `no996_mode` changes phase.
 */

export const WORK_MODES = Object.freeze(['auto', 'chat', 'design', 'produce']);
export const EFFECTIVE_PHASES = Object.freeze(['chat', 'design', 'produce']);

export const WORK_MODE_META = Object.freeze({
  auto: {
    label: '智能自动',
    shortLabel: '自动',
    description: '按需求复杂度与素材状态自动切换：简单问答直接回，复杂做片先设计分镜再执行。',
  },
  chat: {
    label: '快速对话',
    shortLabel: '对话',
    description: '轻量问答、改单句字幕或微调参数，不强制走完整分镜与重制流程。',
  },
  design: {
    label: '导演设计',
    shortLabel: '设计',
    description: '先全盘盘点素材并出「导演视觉与动效设计卡」与分镜，确认后再执行制作。',
  },
  produce: {
    label: '制片执行',
    shortLabel: '制片',
    description: '按分镜全速落地：G2 定调帧 → G3 原创动效与克制音效 → G5 100分自检 → G6 导出验证。',
  },
});

export function normalizeWorkModeState(raw) {
  const mode = WORK_MODES.includes(raw?.mode) ? raw.mode : 'auto';
  const defaultPhase = mode === 'auto' ? 'chat' : mode;
  const effective = EFFECTIVE_PHASES.includes(raw?.effective)
    ? (mode === 'auto' ? raw.effective : mode)
    : defaultPhase;
  const autoExport = raw?.autoExport === true;
  const reason = typeof raw?.reason === 'string' ? raw.reason.slice(0, 160) : '';
  const updatedAt = Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : 0;
  return { mode, effective, autoExport, reason, updatedAt };
}

/**
 * One live state line for the DSH prompt context. Workflow policy lives in the
 * preset section; this is not prepended to user text.
 */
export function promptPrefixForWorkMode(rawState) {
  const state = normalizeWorkModeState(rawState);
  return `会话模式：${WORK_MODE_META[state.mode].label}（${state.mode}）｜当前阶段 ${state.effective}｜自动导出：${state.autoExport ? '开启' : '关闭'}`;
}
