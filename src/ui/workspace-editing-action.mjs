const PROJECT_ID = /^[A-Za-z0-9_-]{6,40}$/;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function readWorkspaceEditingTarget(sessionId, signal, request = globalThis.fetch) {
  const response = await request('/api/no996-openfilm/editing-session-target', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!response.ok) throw new Error('EDITING_TARGET_UNAVAILABLE');
  const { target } = await response.json();
  if (target === null) return null;
  if (typeof target?.projectId !== 'string' || !PROJECT_ID.test(target.projectId) ||
      typeof target?.conversationId !== 'string' || !CONVERSATION_ID.test(target.conversationId) ||
      typeof target?.archived !== 'boolean') throw new Error('EDITING_TARGET_INVALID');
  return target;
}

export async function openWorkspaceEditingTarget({ sessionId, signal, readTarget, selectPanel, navigate }) {
  if (signal.aborted) return false;
  const target = await readTarget(sessionId, signal);
  if (signal.aborted || !target || target.archived) return false;
  selectPanel();
  navigate(target.projectId, target.conversationId);
  return true;
}

// DSH's own Session header gives us the native sessionId. No DOM row inspection,
// workspace opening, session creation or modification of DSH's current session.
export function createWorkspaceEditingAction(React, { t, layout, navigate }) {
  const h = React.createElement;
  return function WorkspaceEditingAction({ sessionId }) {
    const [state, setState] = React.useState(null);
    const active = React.useRef(null);
    React.useEffect(() => {
      if (!sessionId) return undefined;
      const controller = new AbortController();
      active.current = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]);
      void readWorkspaceEditingTarget(sessionId, signal).then(target => {
        if (!controller.signal.aborted) setState({ sessionId, target });
      }).catch(() => {
        if (!controller.signal.aborted) setState({ sessionId, failure: true });
      });
      return () => controller.abort();
    }, [sessionId]);
    if (state?.sessionId !== sessionId || (!state?.target && !state?.failure)) return null;
    const { opening, failure, target } = state;
    const archived = target?.archived === true;
    const label = archived ? t('editingTargetArchived') : failure ? t('editingTargetRetry') : t('editingTargetOpen');
    return h('button', {
      type: 'button', disabled: archived || opening, title: label,
      style: { paddingInline: '6px', minHeight: '24px', color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' },
      onClick: async () => {
        const controller = active.current;
        if (!controller || controller.signal.aborted) return;
        const navigation = layout.beginNavigation();
        const signal = AbortSignal.any([navigation, controller.signal, AbortSignal.timeout(12000)]);
        setState({ sessionId, target, failure, opening: true });
        try {
          const opened = await openWorkspaceEditingTarget({
            sessionId, signal, readTarget: readWorkspaceEditingTarget,
            selectPanel: () => layout.selectPanel('no996-openfilm'), navigate,
          });
          if (!controller.signal.aborted) setState({ sessionId, target, failure: !opened });
        } catch {
          if (!controller.signal.aborted) setState({ sessionId, target, failure: true });
        }
      },
    }, opening ? t('editingTargetOpening') : label);
  };
}
