// The workspace/sidebar may ask for a project before the iframe has mounted.
// Keep the newest exact target until the frame confirms it, including across
// a reload during a failed history fetch. A URL change alone is not a chat ACK.
function normalizeProjectId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(value) ? value : null;
}

function normalizeSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

export function createAreaBus() {
  const listeners = new Set();
  let pending = null;
  let projectId = null;
  let sequence = 0;
  function emit(event) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* one broken listener must not starve the other */ }
    }
  }
  const report = next => {
    projectId = next;
    emit({ type: 'project', projectId });
  };
  return {
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    navigate(project, sessionId) {
      const id = normalizeProjectId(project);
      const sid = normalizeSessionId(sessionId);
      if (!id || (sessionId !== undefined && !sid)) return false;
      pending = Object.freeze({ requestId: ++sequence, projectId: id, ...(sid ? { sessionId: sid } : {}) });
      emit({ type: 'navigate', ...pending });
      return true;
    },
    pendingTarget: () => pending,
    acknowledge({ requestId, projectId: project, sessionId, status } = {}) {
      if (!pending?.sessionId || pending.requestId !== requestId || pending.projectId !== project || pending.sessionId !== sessionId ||
          (status !== 'ready' && status !== 'cancelled')) return false;
      pending = null;
      if (status === 'ready') report(project);
      return true;
    },
    reportProject(project) {
      const id = normalizeProjectId(project);
      if (pending) {
        // A project-only request can settle when the frame reports its route;
        // an explicit conversation requires its separate, stamped ACK.
        if (pending.sessionId || pending.projectId !== id) return false;
        pending = null;
      }
      report(id);
      return true;
    },
    snapshot: () => ({ projectId, pending }),
  };
}

export const areaBus = createAreaBus();
