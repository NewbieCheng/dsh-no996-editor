/**
 * `openfilm_mode`: lets the AI explicitly report or transition the conversation's
 * active work phase (`chat` | `design` | `produce`) according to task complexity
 * or user approval, keeping the left chat composer's WorkModePill in real-time sync.
 */
import { EFFECTIVE_PHASES, WORK_MODES, WORK_MODE_META } from '../native/work-mode.mjs';

export function createModeTool({ isProjectAgent, projectOf, getMode, setMode } = {}) {
  return {
    name: 'openfilm_mode',
    description: 'Inspect or switch this conversation\'s active work phase (`chat` for Q&A/small edits, `design` for director planning & storyboard design before building, `produce` for full execution & 100-pt quality verification). Call this in `auto` mode when task complexity changes, or after the user confirms a design plan in `design` mode.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phase: { type: 'string', enum: [...EFFECTIVE_PHASES], description: 'Target active phase for the current work.' },
        mode: { type: 'string', enum: [...WORK_MODES], description: 'Optional top-level mode override (e.g. switch design -> produce after user approval).' },
        reason: { type: 'string', description: 'Short Chinese reason shown/logged for why the mode switched.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (typeof isProjectAgent !== 'function' || isProjectAgent(exec?.agent) !== true) {
        throw new Error('This tool is available only to a conversation bound to an OpenFilm project.');
      }
      const project = projectOf?.(exec.agent);
      if (!project?.projectId) {
        throw new Error('This conversation is not bound to an OpenFilm project.');
      }
      const conversation = project.conversation ?? '';
      const current = typeof getMode === 'function'
        ? await getMode(project.projectId, conversation)
        : { mode: 'auto', effective: 'chat', reason: '' };

      if (!args?.phase && !args?.mode) {
        return {
          text: `当前工作模式：${WORK_MODE_META[current.mode]?.label ?? current.mode}（阶段：${current.effective}）${current.reason ? ` — ${current.reason}` : ''}`,
        };
      }

      const nextMode = WORK_MODES.includes(args?.mode) ? args.mode : current.mode;
      const nextPhase = EFFECTIVE_PHASES.includes(args?.phase)
        ? args.phase
        : (nextMode === 'auto' ? current.effective : nextMode);
      const reason = typeof args?.reason === 'string' ? args.reason.trim().slice(0, 120) : '';

      const updated = typeof setMode === 'function'
        ? await setMode(project.projectId, conversation, { mode: nextMode, effective: nextPhase, reason })
        : { mode: nextMode, effective: nextPhase, reason };

      return {
        text: `已切换工作阶段：${WORK_MODE_META[updated.mode]?.label ?? updated.mode} · ${updated.effective}${updated.reason ? `（${updated.reason}）` : ''}。`,
      };
    },
  };
}
