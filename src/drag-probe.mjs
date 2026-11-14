/**
 * Where does a dragged file stop being a drag?
 *
 * Three layers can swallow an external file drag before any drop handler runs: the
 * desktop window, the plugin's page, and the official shell's frame. This probe
 * reports each layer's first sighting to the Host log, so one reproduction says
 * which layer is the wall instead of guessing again.
 *
 * `layer` names the frame: `host` is the DSH page (our panel's parent), `shell` is
 * the frame that holds the official UI.
 */
const SEEN_LIMIT = 3;
const DEFAULT_ENDPOINT = '/api/no996-openfilm/drag-probe';

export function installDragProbe({ window: view = globalThis.window, layer, fetch: send = globalThis.fetch, endpoint = DEFAULT_ENDPOINT } = {}) {
  if (!view || typeof view.addEventListener !== 'function' || typeof send !== 'function') return () => {};
  const seen = new Map();
  const report = (type, event) => {
    const data = event?.dataTransfer;
    const types = data && typeof data.types !== 'undefined' ? [...data.types].join(',').slice(0, 60) : '';
    if (type !== 'boot' && !types.includes('Files') && type !== 'drop') return;
    const key = `${type}|${types}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > SEEN_LIMIT) return;
    const target = event?.target;
    const tag = target && target.tagName ? String(target.tagName).slice(0, 20) : '';
    // Plain body: this endpoint belongs to the DSH web origin, not the editor proxy.
    const body = { layer, type, types, files: data && data.files ? data.files.length : 0, target: tag };
    try {
      const result = send(endpoint, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch { /* a probe must never break the page */ }
  };
  const handlers = {
    dragenter: event => report('dragenter', event),
    dragover: event => report('dragover', event),
    drop: event => report('drop', event),
  };
  for (const [type, handler] of Object.entries(handlers)) view.addEventListener(type, handler, true);
  report('boot', null);
  return () => {
    for (const [type, handler] of Object.entries(handlers)) {
      try { view.removeEventListener(type, handler, true); } catch { /* gone */ }
    }
  };
}
