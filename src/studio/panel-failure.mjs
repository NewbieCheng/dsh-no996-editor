const CODES = new Set(['PANEL_BOOTSTRAP_FAILED', 'IFRAME_SILENT_TIMEOUT', 'RESTART_REQUIRED', 'VERSION_INCOMPATIBLE', 'OFFICIAL_SHELL_UNAVAILABLE', 'STUDIO_START', 'STUDIO_CLOSE', 'STUDIO_DEPENDENCY', 'STUDIO_DISPOSED', 'DSH_ORIGIN_REJECTED', 'DSH_SESSION_REQUIRED', 'DSH_BROWSER_REQUIRED']);

/** The shareable report is assembled from an allowlist, never raw error text or iframe data. */
export function studioFailureSummary({ code, httpStatus, at = new Date(), attempt = 0 } = {}) {
  const safeCode = CODES.has(code) ? code : 'PANEL_BOOTSTRAP_FAILED';
  const stage = safeCode === 'IFRAME_SILENT_TIMEOUT' ? 'shell-boot' : 'host-bootstrap';
  return ['No996 Studio · Startup diagnostic', `Time: ${at.toISOString()}`, `Stage: ${stage}`,
    `Code: ${safeCode}`, Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? `HTTP: ${httpStatus}` : '',
    `Attempt: ${Number.isSafeInteger(attempt) && attempt >= 0 ? attempt + 1 : 1}`].filter(Boolean).join('\n');
}
