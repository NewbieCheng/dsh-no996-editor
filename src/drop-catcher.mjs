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
  attachType = 'no996:attach-files',
} = {}) {
  if (!view || !doc || typeof view.addEventListener !== 'function') return () => {};

  let overlay = null;
  const remove = () => { if (overlay) { overlay.remove(); overlay = null; } };
  const hasFiles = data => Boolean(data && (data.files?.length || [...data.types].includes('Files')));

  const show = () => {
    if (overlay || !isActive()) return;
    overlay = doc.createElement('div');
    overlay.setAttribute('data-no996-drop-catcher', '');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.32);font:13px/1.5 system-ui,sans-serif;color:#FF6400;';
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
    if (!hasFiles(event.dataTransfer)) return;
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
