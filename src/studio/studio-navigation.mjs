// Browser half of the exact editing handoff. Kept self-contained because the
// proxy serializes it into its same-origin shell bootstrap script.
export function installStudioNavigation({ win, parentOrigin, targetOrigin, desktop, reportProject }) {
  const historyKey = '__no996EditingTarget';
  const projectPattern = /^[A-Za-z0-9_-]{6,40}$/;
  const sessionPattern = /^[A-Za-z0-9_-]{1,64}$/;
  const validTarget = value => value && typeof value.projectId === 'string' && projectPattern.test(value.projectId) &&
    typeof value.sessionId === 'string' && sessionPattern.test(value.sessionId) &&
    Number.isSafeInteger(value.requestId) && value.requestId > 0;
  const routeProject = () => /^\/projects\/([\w-]{6,40})\/?$/.exec(win.location.pathname)?.[1];
  const historyRecord = () => {
    const value = win.history.state;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  };
  const same = (left, right) => left && right && left.projectId === right.projectId && left.sessionId === right.sessionId && left.requestId === right.requestId;
  const restored = historyRecord()[historyKey];
  let target = validTarget(restored) && restored.projectId === routeProject() ? restored : undefined;
  let shown = false;
  win.__no996PendingSession = target;

  function publishSelection() {
    win.dispatchEvent(new win.CustomEvent('no996-openfilm:select-session', { detail: win.__no996PendingSession }));
  }
  function result(status) {
    if (!target || win.parent === win) return;
    try { win.parent.postMessage({ type: 'no996-openfilm:navigation-result', version: 1, ...target, status }, targetOrigin); }
    catch { /* a replaced parent is no longer listening */ }
  }
  function clearHistory() {
    const current = historyRecord();
    if (!Object.hasOwn(current, historyKey)) return;
    const rest = { ...current };
    delete rest[historyKey];
    try { win.history.replaceState(rest, ''); } catch { /* document may have left */ }
  }
  win.addEventListener('popstate', () => {
    if (!target || routeProject() === target.projectId) return;
    if (!shown) result('cancelled');
    target = undefined;
    shown = false;
    win.__no996PendingSession = undefined;
    publishSelection();
    reportProject(true);
  });
  win.addEventListener('no996-openfilm:editing-shown', event => {
    const current = event.detail;
    if (!target || current?.projectId !== target.projectId || routeProject() !== target.projectId) return;
    if (same(current, target)) {
      shown = true;
      result('ready');
    } else if (shown && current.sessionId !== target.sessionId) {
      // The person selected another conversation in the editor. Refresh must
      // not reopen the older explicit handoff over that new selection.
      target = undefined;
      shown = false;
      clearHistory();
    }
  });
  win.addEventListener('message', event => {
    if (win.parent === win || event.source !== win.parent ||
        !(event.origin === parentOrigin || (desktop && event.origin === 'null'))) return;
    const data = event.data;
    if (data?.type !== 'no996-openfilm:navigate' || data.version !== 1 || typeof data.projectId !== 'string' || !projectPattern.test(data.projectId)) return;
    if (data.sessionId !== undefined && !validTarget(data)) return;
    const { projectId, sessionId, requestId } = data;
    const explicit = sessionId ? { projectId, sessionId, requestId } : undefined;
    if (same(target, explicit) && routeProject() === projectId) {
      if (shown) result('ready');
      return;
    }
    target = explicit;
    shown = false;
    win.__no996PendingSession = target;
    if (routeProject() !== projectId) {
      try {
        win.history.pushState(target ? { [historyKey]: target } : {}, '', '/projects/' + projectId);
        win.dispatchEvent(new win.PopStateEvent('popstate', { state: win.history.state }));
      } catch {
        // Do not degrade an exact request into an ordinary project navigation.
        if (!target) try { win.location.assign('/projects/' + projectId); } catch { /* document gone */ }
      }
    } else if (target) {
      try { win.history.replaceState({ ...historyRecord(), [historyKey]: target }, ''); } catch { /* in-memory request still works */ }
    } else {
      clearHistory();
    }
    publishSelection();
    if (!target) reportProject(true);
  });
}
