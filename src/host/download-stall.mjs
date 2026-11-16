/**
 * Stall / idle abort for long downloads.
 *
 * Total wall-clock time is unbounded: as long as bytes keep arriving, the watch
 * resets. Two phases:
 *   connecting — no response yet; abort after connectMs
 *   downloading — response open; abort after idleMs without a new chunk
 *
 * Call `connected()` when headers/body start, `activity()` on every chunk, and
 * `clear()` in a finally. Pass `signal` to fetch / readers.
 */
export const DEFAULT_CONNECT_MS = 20_000;
export const DEFAULT_IDLE_MS = 30_000;

export function createStallWatch({
  idleMs = DEFAULT_IDLE_MS,
  connectMs = DEFAULT_CONNECT_MS,
  now = Date.now,
  onStall,
} = {}) {
  if (!Number.isFinite(idleMs) || idleMs < 1) throw new RangeError('invalid idleMs');
  if (!Number.isFinite(connectMs) || connectMs < 1) throw new RangeError('invalid connectMs');

  const controller = new AbortController();
  let phase = 'connecting';
  let timer = null;
  let lastActivity = now();

  function fail(code, message) {
    if (controller.signal.aborted) return;
    const error = Object.assign(new Error(message), { code });
    try { onStall?.(error); } catch { /* UI hooks must not break abort */ }
    try { controller.abort(error); } catch { try { controller.abort(); } catch { /* already */ } }
  }

  function arm(ms) {
    clearTimeout(timer);
    if (controller.signal.aborted) return;
    timer = setTimeout(() => {
      if (phase === 'connecting') {
        fail('DOWNLOAD_CONNECT_TIMEOUT', `连接超时（${Math.round(connectMs / 1000)} 秒内未收到响应）`);
      } else {
        fail('DOWNLOAD_STALL', `下载停滞（${Math.round(idleMs / 1000)} 秒未收到新数据）`);
      }
    }, ms);
  }

  arm(connectMs);

  return {
    signal: controller.signal,
    get phase() { return phase; },
    get lastActivity() { return lastActivity; },
    /** Headers / body started — switch from connect window to idle window. */
    connected() {
      if (controller.signal.aborted) return;
      phase = 'downloading';
      lastActivity = now();
      arm(idleMs);
    },
    /** A chunk arrived — keep the connection alive. */
    activity() {
      if (controller.signal.aborted) return;
      phase = 'downloading';
      lastActivity = now();
      arm(idleMs);
    },
    clear() {
      clearTimeout(timer);
      timer = null;
    },
  };
}

/** Prefer the stall reason when an AbortError wraps it. */
export function stallReason(error) {
  if (!error) return null;
  if (error.code === 'DOWNLOAD_STALL' || error.code === 'DOWNLOAD_CONNECT_TIMEOUT') return error;
  const cause = error.cause;
  if (cause && (cause.code === 'DOWNLOAD_STALL' || cause.code === 'DOWNLOAD_CONNECT_TIMEOUT')) return cause;
  if (error.name === 'AbortError' && cause) return stallReason(cause);
  return null;
}

/** Merge an external AbortSignal with the stall watch (Node 20+ AbortSignal.any). */
export function linkSignals(stallSignal, external) {
  if (!external) return stallSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([stallSignal, external]);
  const controller = new AbortController();
  const forward = (signal) => {
    if (!signal) return;
    if (signal.aborted) {
      try { controller.abort(signal.reason); } catch { /* already */ }
      return;
    }
    signal.addEventListener('abort', () => {
      try { controller.abort(signal.reason); } catch { /* already */ }
    }, { once: true });
  };
  forward(stallSignal);
  forward(external);
  return controller.signal;
}
