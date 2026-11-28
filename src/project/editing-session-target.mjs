// Translate a native DSH session into a Studio conversation without opening
// an Agent, guessing from a title/cwd, or substituting the last conversation.
const PROJECT = /^[A-Za-z0-9_-]{6,40}$/;
const CONVERSATION = /^[A-Za-z0-9_-]{1,64}$/;
export const NATIVE_EDITING_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function uniqueBinding(rows, sessionId) {
  const matches = rows.filter(row => row?.sessionId === sessionId);
  if (matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'unbound' };
  const [binding] = matches;
  if (typeof binding.projectId !== 'string' || !PROJECT.test(binding.projectId) ||
      typeof binding.conversation !== 'string' || !CONVERSATION.test(binding.conversation)) return { status: 'unresolved' };
  return { status: 'bound', projectId: binding.projectId, conversation: binding.conversation };
}

export async function resolveEditingSessionTarget({ bindings, loadChat, isArchived }, sessionId) {
  if (!NATIVE_EDITING_SESSION_ID.test(sessionId ?? '')) return { status: 'invalid' };
  const result = uniqueBinding(bindings(), sessionId);
  if (result.status !== 'bound') return result;
  const { projectId, conversation } = result;
  // loadChat verifies that the project is still registered and owns its history.
  const data = await loadChat(projectId);
  const current = uniqueBinding(bindings(), sessionId);
  if (current.status !== 'bound' || current.projectId !== projectId || current.conversation !== conversation) return { status: 'changed' };
  const matches = (Array.isArray(data?.sessions) ? data.sessions : []).filter(row =>
    CONVERSATION.test(row?.id ?? '') && (row.id === conversation || row.agentSessions?.deepseek === conversation));
  if (matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'unresolved' };
  const [row] = matches;
  return {
    status: 'ready',
    target: { projectId, conversationId: row.id, archived: row.archived === true || isArchived(sessionId) === true },
  };
}
