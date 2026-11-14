/**
 * A dropped file's real path only the desktop window can name (Electron's
 * webUtils). Our panel is a cross-origin iframe on the Studio proxy, where that
 * bridge is absent, so the frame that has it answers for the frame that does not:
 * the shell asks, the DSH page replies.
 *
 * Nothing here is required for a drop to work — without an answer the file is
 * copied into the project, which is what a pasted file has always done.
 */
export function installHostPathBridge({ window: view = globalThis.window } = {}) {
  if (!view || typeof view.addEventListener !== 'function') return () => {};
  const bridge = view.__DSH_HOST_PATHS__;
  const reply = (event) => {
    const data = event?.data;
    if (!data || data.type !== 'no996:path-for-file' || typeof data.id !== 'string') return;
    let path = '';
    try {
      path = typeof bridge?.pathFor === 'function' ? String(bridge.pathFor(data.file) ?? '') : '';
    } catch { path = ''; }
    try { event.source?.postMessage({ type: 'no996:path-for-file:reply', id: data.id, path }, '*'); }
    catch { /* the asking frame is gone */ }
  };
  view.addEventListener('message', reply);
  return () => { try { view.removeEventListener('message', reply); } catch { /* gone */ } };
}
