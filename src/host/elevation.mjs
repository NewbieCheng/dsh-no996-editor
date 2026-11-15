/**
 * Why a file cannot be dragged into the window: Windows blocks OLE drag-and-drop
 * from a lower integrity level into a higher one (UIPI). When the desktop app was
 * started as administrator, Explorer and WeChat are "medium" and the app is "high",
 * so the window receives nothing at all — no `dragenter`, not even for DSH's own
 * composer — while the same page in a browser accepts drops normally.
 *
 * `net session` is the locale-independent check: it succeeds only for an elevated
 * administrator token.
 */
import { execFileSync } from 'node:child_process';

export function createElevationProbe({ exec = execFileSync, platform = process.platform } = {}) {
  let answer;
  return function isElevated() {
    if (answer !== undefined) return answer;
    if (platform !== 'win32') { answer = typeof process.getuid === 'function' && process.getuid() === 0; return answer; }
    try {
      exec('net', ['session'], { stdio: 'ignore', windowsHide: true, timeout: 2000 });
      answer = true;
    } catch {
      answer = false;
    }
    return answer;
  };
}
