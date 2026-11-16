// Replaces the DSH top-left sidebar brand slot (DH / DeepSeek logo) with the
// No996 workbench mark. Installed via ctx.effect so disabling/unloading the
// plugin restores the original logo without leaving stale DOM behind.

const MARK_ATTR = 'data-no996-brand-mark';
const REPLACED_ATTR = 'data-no996-brand-replaced';
const STYLE_ATTR = 'data-no996-brand-style';

const PATH_RING = 'M 239 262 L 239 345 L 450 346 L 171 625 L 295 625 L 443 478 L 445 723 L 541 723 L 543 479 L 689 635 L 761 577 L 751 563 L 609 408 L 509 407 L 569 345 L 775 345 L 775 262 Z M 601 16 L 530 8 L 470 9 L 422 15 L 381 24 L 337 38 L 303 52 L 273 67 L 241 86 L 208 109 L 170 141 L 143 168 L 105 214 L 77 256 L 58 291 L 38 338 L 24 382 L 14 427 L 9 467 L 8 530 L 12 573 L 18 606 L 31 652 L 46 690 L 68 733 L 93 772 L 123 811 L 166 856 L 191 878 L 226 904 L 268 929 L 302 945 L 348 961 L 407 973 L 443 974 L 319 846 L 286 831 L 257 813 L 220 783 L 187 748 L 153 700 L 127 650 L 109 600 L 100 554 L 97 510 L 99 467 L 107 417 L 122 367 L 148 310 L 171 272 L 208 226 L 244 191 L 290 157 L 334 133 L 365 120 L 421 104 L 477 96 L 522 95 L 567 99 L 622 111 L 674 130 L 725 158 L 768 190 L 811 232 L 841 269 L 861 300 L 876 328 L 891 364 L 900 391 L 910 435 L 993 409 L 987 381 L 974 340 L 954 293 L 935 258 L 907 215 L 867 166 L 831 130 L 810 112 L 786 94 L 745 68 L 712 51 L 678 37 L 651 28 Z';
const PATH_ARROW = 'M 1014 452 L 801 510 L 851 548 L 510 847 L 408 744 L 337 808 L 337 810 L 505 971 L 507 971 L 924 612 L 967 662 Z';

export function brandSvgMarkup({ dark = true, size = 22 } = {}) {
  const ring = dark ? '#FFFFFF' : '#051D43';
  const arrow = dark ? '#FF7200' : '#FF6400';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-8.22 0 1039.44 983" width="${size}" height="${size}" role="img" aria-label="今天不加班" style="display:block;flex:none;"><path fill="${ring}" fill-rule="evenodd" d="${PATH_RING}"/><path fill="${arrow}" fill-rule="evenodd" d="${PATH_ARROW}"/></svg>`;
}

function isDarkDoc(doc) {
  const root = doc.documentElement;
  if (!root) return true;
  const theme = (root.getAttribute('data-theme') || root.dataset?.theme || '').toLowerCase();
  if (theme.includes('dark') || theme === 'deepsea') return true;
  if (theme === 'light' || theme === 'sky' || theme === 'minimal') return false;
  if (root.classList?.contains('dark')) return true;
  try {
    const bg = doc.defaultView?.getComputedStyle?.(doc.body)?.backgroundColor || '';
    const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const luma = (Number(match[1]) * 299 + Number(match[2]) * 587 + Number(match[3]) * 114) / 1000;
      return luma < 128;
    }
  } catch { /* ignore */ }
  return true;
}

function isNavButton(el) {
  const label = (el.textContent || '').trim();
  return /^(插件|自动化任务|视频创作|更多|新对话|工作区|剪辑区|Plugins|Automation|Video studio|More|New chat)$/i.test(label);
}

/** Locate the top-left DSH brand logo element inside the sidebar header area. */
export function findSidebarBrandSlot(doc) {
  const explicit = doc.querySelector(
    'aside img[alt*="DeepSeek" i], aside svg[aria-label*="DeepSeek" i], nav img[alt*="DeepSeek" i], nav svg[aria-label*="DeepSeek" i], [data-testid*="brand" i], [data-testid*="logo" i]'
  );
  if (explicit) return explicit;

  // Fallback: find the sidebar container holding the top nav entries and pick
  // the top-left logo svg/img positioned above the first nav button.
  const navItem = [...doc.querySelectorAll('button, [role="button"], a')].find(
    el => /^(插件|自动化任务|Plugins|Automation)$/i.test((el.textContent || '').trim())
  );
  if (!navItem) return null;

  let container = navItem.parentElement;
  for (let i = 0; i < 6 && container; i += 1) {
    const rect = container.getBoundingClientRect?.();
    if (rect && rect.width > 120 && rect.width < 460 && rect.left < 120 && rect.height > 200) {
      break;
    }
    container = container.parentElement;
  }
  if (!container) return null;

  const navTop = navItem.getBoundingClientRect?.().top ?? 120;
  for (const media of container.querySelectorAll('svg, img')) {
    if (media.closest?.(`[${MARK_ATTR}]`)) continue;
    const ownerBtn = media.closest?.('button, [role="button"], a');
    if (ownerBtn && isNavButton(ownerBtn)) continue;
    const rect = media.getBoundingClientRect?.();
    if (!rect || rect.width < 14 || rect.width > 160 || rect.height < 14 || rect.height > 64) continue;
    if (rect.top <= navTop && rect.left < 240) return media;
  }
  return null;
}

export function installSidebarBrand({ document: doc } = {}) {
  if (!doc || typeof doc.createElement !== 'function') return () => {};

  let replacedTarget = null;
  let markNode = null;
  let lastDark = null;
  let styleNode = null;

  const ensureStyle = () => {
    if (styleNode?.isConnected) return;
    styleNode = doc.createElement('style');
    styleNode.setAttribute(STYLE_ATTR, '');
    styleNode.textContent = `[${MARK_ATTR}]{display:inline-flex;align-items:center;gap:8px;vertical-align:middle;}[${MARK_ATTR}] .n996-brand-text{font:600 13px/1.2 "Inter","PingFang SC","Microsoft YaHei",system-ui,sans-serif;letter-spacing:-0.01em;white-space:nowrap;}`;
    (doc.head ?? doc.documentElement)?.append(styleNode);
  };

  const cleanup = () => {
    if (markNode?.isConnected) markNode.remove();
    markNode = null;
    if (replacedTarget) {
      replacedTarget.style.display = '';
      replacedTarget.removeAttribute(REPLACED_ATTR);
      replacedTarget = null;
    }
    if (styleNode?.isConnected) styleNode.remove();
    styleNode = null;
    lastDark = null;
  };

  const sync = () => {
    const dark = isDarkDoc(doc);
    if (replacedTarget?.isConnected && markNode?.isConnected) {
      if (lastDark !== dark) {
        lastDark = dark;
        const svgSlot = markNode.querySelector('.n996-brand-svg');
        if (svgSlot) svgSlot.innerHTML = brandSvgMarkup({ dark, size: 22 });
      }
      return;
    }

    const slot = findSidebarBrandSlot(doc);
    if (!slot || !slot.parentElement) return;
    if (replacedTarget && replacedTarget !== slot) cleanup();

    ensureStyle();
    const rect = slot.getBoundingClientRect?.();
    const wide = rect && rect.width > 56;
    const size = wide ? 22 : Math.max(18, Math.min(26, Math.round(rect?.height || 22)));

    slot.setAttribute(REPLACED_ATTR, '');
    slot.style.display = 'none';

    markNode = doc.createElement('span');
    markNode.setAttribute(MARK_ATTR, '');
    markNode.title = '今天不加班 · 智能工作台';

    const svgSlot = doc.createElement('span');
    svgSlot.className = 'n996-brand-svg';
    svgSlot.innerHTML = brandSvgMarkup({ dark, size });
    markNode.append(svgSlot);

    if (wide) {
      const label = doc.createElement('span');
      label.className = 'n996-brand-text';
      label.textContent = '今天不加班';
      markNode.append(label);
    }

    slot.parentElement.insertBefore(markNode, slot);
    replacedTarget = slot;
    lastDark = dark;
  };

  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    const run = () => { scheduled = false; sync(); };
    if (typeof doc.defaultView?.requestAnimationFrame === 'function') doc.defaultView.requestAnimationFrame(run);
    else setTimeout(run, 50);
  };

  const observer = new (doc.defaultView?.MutationObserver ?? MutationObserver)(schedule);
  observer.observe(doc.body ?? doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-theme', 'class'],
  });
  sync();

  return () => {
    observer.disconnect();
    cleanup();
  };
}
