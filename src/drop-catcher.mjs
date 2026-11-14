/**
 * A file dropped on the panel has to arrive even when the frame that holds the
 * official UI never sees a drag: a cross-origin frame can be skipped by the OS
 * drag path, and then every pixel of it shows "no entry" (the frame cannot even
 * say it accepts, because it gets no `dragover`).
 *
 * So the DSH page — which demonstrably sees file drags — catches the drop on a
 * full-panel overlay while the panel is on screen, then hands the files to the
 * frame that can use them. The overlay exists only during a drag.
 */
export function installDropCatcher({
  window: view = globalThis.window,
  document: doc = globalThis.document,
  isActive = () => false,
  frame = () => null,
  elementOf = () => null,
  attachType = 'no996:attach-files',
} = {}) {
  if (!view || !doc || typeof view.addEventListener !== 'function') return () => {};

  let overlay = null;
  const boxOf = () => {
    const element = typeof elementOf === 'function' ? elementOf() : null;
    const rect = element && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
    if (rect && rect.width > 0 && rect.height > 0) return rect;
    const width = view.innerWidth || 0;
    const height = view.innerHeight || 0;
    return { left: 0, top: 0, width, height };
  };
  const remove = () => { if (overlay) { overlay.remove(); overlay = null; } };
  /* `types` can be empty for a drag that started outside the app, so the overlay
     must not wait for it: any drag entering the page while the panel is on screen
     is treated as a candidate, and the drop decides by what actually arrived. */
  const looksLikeDrag = data => Boolean(data);

  const show = () => {
    if (overlay || !isActive()) return;
    overlay = doc.createElement('div');
    overlay.setAttribute('data-no996-drop-catcher', '');
    overlay.style.cssText = 'position:fixed;z-index:2147483001;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.32);font:13px/1.5 system-ui,sans-serif;color:#FF6400;';
    // Sit exactly on the panel, not over the whole window: the sidebar must not
    // look broken just because a file is in the air.
    const box = boxOf();
    overlay.style.left = `${Math.round(box.left)}px`;
    overlay.style.top = `${Math.round(box.top)}px`;
    overlay.style.width = `${Math.round(box.width)}px`;
    overlay.style.height = `${Math.round(box.height)}px`;
    const hint = doc.createElement('div');
    hint.textContent = '松手即可附上';
    hint.style.cssText = 'padding:16px 24px;border:2px dashed #FF6400;border-radius:12px;background:var(--dsw-alias-bg-elevated,#232325);pointer-events:none;';
    overlay.append(hint);
    overlay.addEventListener('dragover', event => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });
    overlay.addEventListener('dragleave', event => { if (!event.relatedTarget) remove(); });
    overlay.addEventListener('drop', event => {
      event.preventDefault();
      const files = [...(event.dataTransfer?.files ?? [])];
      remove();
      hand(files);
    });
    doc.body.append(overlay);
  };

  const hand = files => {
    if (!files.length) return;
    const target = frame();
    if (!target || typeof target.postMessage !== 'function') return;
    try { target.postMessage({ type: attachType, files }, '*'); } catch { /* frame is gone */ }
  };

  const onEnter = event => {
    if (!looksLikeDrag(event.dataTransfer)) return;
    show();
  };
  /* the overlay can be dismissed by a drag that ends anywhere */
  const onEnd = () => remove();
  view.addEventListener('dragenter', onEnter, true);
  view.addEventListener('dragleave', onEnd, true);
  view.addEventListener('drop', onEnd, true);
  view.addEventListener('dragend', onEnd, true);
  return () => {
    remove();
    try {
      view.removeEventListener('dragenter', onEnter, true);
      view.removeEventListener('dragleave', onEnd, true);
      view.removeEventListener('drop', onEnd, true);
      view.removeEventListener('dragend', onEnd, true);
    } catch { /* gone */ }
  };
}
