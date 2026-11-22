// The page reports why the microphone did not start. Only the failure class is kept:
// permission policy, user/system denial, no device, unable to start, unsupported
// environment. Anything else — a message, a device name, dictated text — never
// reaches the log, so a diagnosis cannot leak what was being said.
export const MIC_FAILURES = Object.freeze(['micPolicy', 'micDenied', 'micMissing', 'micUnavailable', 'micUnsupported']);

const KNOWN = new Set(MIC_FAILURES);

/**
 * The failure code to log, or null when the page sent something unknown.
 * @param {{ d?: unknown, detail?: unknown } | null | undefined} payload
 */
export function micFailureCode(payload) {
  const detail = payload?.detail;
  return typeof detail === 'string' && KNOWN.has(detail) ? detail : null;
}
