// The single source of truth for what this plugin grants the Studio frame.
//
// Microphone dictation needs two independent grants:
//   1. this plugin must delegate `microphone` to the embedded frame (the iframe
//      `allow` attribute below), and
//   2. the OS / DSH desktop app must let the page capture audio (getUserMedia).
//
// We own (1) and can prove it in diagnostics. We cannot grant (2) from plugin
// code: a `micDenied` failure means the user has to allow the microphone in
// Windows privacy settings and accept the desktop app's prompt, then retry.
// Keeping the delegation in one place stops the frame and the diagnose report
// from drifting apart, so "did a permission get turned off?" has an honest
// answer instead of a guess.
export const STUDIO_FRAME_ALLOW = Object.freeze(
  'clipboard-read; clipboard-write; fullscreen; microphone',
);

/** Read-only evidence for the diagnose route: what we delegate, and what we cannot grant. */
export function micDelegation() {
  return {
    frameAllowsMicrophone: /(^|;)\s*microphone\s*(;|$)/.test(STUDIO_FRAME_ALLOW),
    // The OS/app grant is outside the plugin; expose it as a known boundary, not a guess.
    systemGrantControlledByPlugin: false,
  };
}
