/**
 * Session-scoped 4-tier work mode state machine for OpenFilm conversations.
 *
 * Keeps ONE stable DSH agent preset (`openfilm-video-editing`) so tool/skill isolation
 * and conversation context are never torn down across mode transitions. The Host
 * owns mode state per `(projectId, conversation)`, injects a concise turn directive,
 * and pushes live `mode_update` SSE frames to the left chat composer pill whenever
 * either the user or the AI (via `openfilm_mode`) switches mode/phase.
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
  const reason = typeof raw?.reason === 'string' ? raw.reason.slice(0, 160) : '';
  const updatedAt = Number.isFinite(Number(raw?.updatedAt)) ? Number(raw.updatedAt) : 0;
  return { mode, effective, reason, updatedAt };
}

/**
 * Concise per-turn directive prepended to the prompt sent to DSH SessionController
 * (never stored into `AGENTS.md` and never duplicated in user-visible chat bubbles).
 */
export function promptPrefixForWorkMode(rawState) {
  const state = normalizeWorkModeState(rawState);
  if (state.mode === 'chat') {
    return '[会话模式：快速对话（chat）— 仅做轻量问答、局部文本/参数微调；除非用户明确要求，不要开重分镜流程，也不要强加音乐卡点或满屏音效。]\n\n';
  }
  if (state.mode === 'design') {
    return '[会话模式：导演设计（design）— 严禁跳过设计直接整片改写或导出！请先全盘盘点素材（openfilm_assets / 识图 / openfilm_frame 抽帧 / 口播 openfilm_transcribe / 人脸 vision / 音乐 openfilm_rhythm），必要时只提1~2个关键创意选择题，然后输出「导演视觉与动效设计卡」并保存 .film/storyboard.json，等待用户确认方案后再用 openfilm_mode 切入 produce 执行。]\n\n';
  }
  if (state.mode === 'produce') {
    return '[会话模式：制片执行（produce）— 按已定分镜或要求推进：G2 定调帧（先做第1镜并抽帧亲眼看）→ G3 量产（用 openfilm_kit 装配运行时、原创隐喻不死套模板，按需用 openfilm_sfx 克制配声）→ G5 抽帧并按 100 分动效转场标准自检（>=80分过闸）→ G6 导出并回读规格。]\n\n';
  }
  // auto
  return `[会话模式：智能自动（auto，当前阶段 ${state.effective}）— 先判断任务复杂度并按需调用 openfilm_mode 切换 phase：问答/小改用 chat；新做片/多素材编排/全片动效升级且尚无已确认分镜时先切 design（盘点素材→出设计卡与 storyboard.json→请用户确认）；方案已确认或明确要求直接制作导出时切 produce 执行并过 100 分自检。]\n\n`;
}
