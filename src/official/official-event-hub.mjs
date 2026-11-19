const PROJECT_ID = /^[A-Za-z0-9_-]{6,40}$/;
const MAX_LISTENERS = 32;
const MAX_EVENT_BYTES = 1024 * 1024;

/** Host-only fan-out. The caller must authorize the project and bind events to
 * the correct DSH session before publishing; this hub does not authenticate a
 * session or persist any user data.
 *
 * It does keep a small in-memory tail per project, so a page whose stream dropped
 * (a laptop lid, a loopback hiccup) can resume from the last sequence it applied
 * instead of losing the middle of a turn. The tail is bounded and short-lived:
 * this is recovery for a reconnect, not history.
 */
const MAX_TAIL_FRAMES = 400;
const MAX_TAIL_BYTES = 1024 * 1024;
const MAX_TAIL_PROJECTS = 32;

export function createOfficialEventHub() {
  const listeners = new Map();
  const tails = new Map();
  let closed = false;
  const project = id => typeof id === 'string' && PROJECT_ID.test(id);
  /** The newest sequence this project published (-1 when it published nothing). */
  const seqOf = projectId => tails.get(projectId)?.seq ?? -1;
  function remember(projectId, seq, data) {
    let tail = tails.get(projectId);
    if (!tail) {
      tails.set(projectId, tail = { seq, frames: [], bytes: 0 });
      while (tails.size > MAX_TAIL_PROJECTS) tails.delete(tails.keys().next().value);
    }
    tail.seq = seq;
    tail.frames.push({ seq, data });
    tail.bytes += Buffer.byteLength(data, 'utf8');
    while (tail.frames.length > MAX_TAIL_FRAMES || (tail.bytes > MAX_TAIL_BYTES && tail.frames.length > 1)) {
      tail.bytes -= Buffer.byteLength(tail.frames.shift().data, 'utf8');
    }
  }
  return Object.freeze({
    subscribe(projectId, listener, options = {}) {
      if (closed || !project(projectId) || typeof listener !== 'function') throw new TypeError('A valid project and listener are required');
      const after = options && Number.isSafeInteger(options.afterSeq) ? options.afterSeq : -1;
      if (after >= 0) {
        const tail = tails.get(projectId);
        // Delivered before the listener joins the live group: the catch-up is
        // ordered and deduplicated by sequence, never interleaved with new frames.
        if (tail) for (const frame of tail.frames) if (frame.seq > after) listener(frame.data);
      }
      let group = listeners.get(projectId);
      if (!group) listeners.set(projectId, group = new Set());
      if (group.size >= MAX_LISTENERS) throw new Error('Too many project listeners');
      group.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        group.delete(listener);
        if (group.size === 0 && listeners.get(projectId) === group) listeners.delete(projectId);
      };
    },
    publish(projectId, event) {
      if (closed || !project(projectId)) throw new TypeError('A valid project is required');
      let data;
      // Sequences start at 1 so that "no cursor yet" (-1) and the first frame differ.
      const seq = (tails.get(projectId)?.seq ?? 0) + 1;
      try { data = JSON.stringify({ ...event, seq }); } catch { throw new TypeError('A serializable event is required'); }
      if (typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > MAX_EVENT_BYTES) throw new TypeError('Event is invalid or too large');
      remember(projectId, seq, data);
      let accepted = false;
      for (const listener of [...(listeners.get(projectId) || [])]) {
        try { if (listener(data) === true) accepted = true; } catch { /* one closed client cannot affect other listeners */ }
      }
      // This is only acceptance by a live transport, not proof the browser
      // rendered or acknowledged the event. There is no history replay here.
      return accepted;
    },
    seqOf,
    close() { closed = true; listeners.clear(); tails.clear(); },
  });
}
