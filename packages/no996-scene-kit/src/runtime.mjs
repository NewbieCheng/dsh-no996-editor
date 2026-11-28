import { captionState } from './scene.mjs';

/** Expose OpenFilm's exact frame(t) contract. Rendering never advances itself. */
export function createFilmRuntime({ width, height, duration, draw, root = globalThis } = {}) {
  if (![width, height].every(value => Number.isInteger(value) && value > 0) || !Number.isFinite(duration) || duration <= 0 || typeof draw !== 'function') {
    throw new TypeError('createFilmRuntime needs positive dimensions, duration and a draw function');
  }
  const at = value => Math.max(0, Math.min(duration, Number.isFinite(value) ? value : 0));
  const film = {
    width, height, duration,
    ready: Promise.resolve(root.document?.fonts?.ready).then(() => { draw(0); return true; }),
    frame(value) { draw(at(value)); },
  };
  root.film = film;
  return film;
}

/** Set every cue from the current time, including hiding inactive cues. */
export function updateCaptions(elements, cues, timeMs, root = globalThis) {
  const active = captionState(cues, timeMs);
  for (const element of elements) {
    const visible = active?.id === element.dataset.elementId;
    element.style.visibility = visible ? 'visible' : 'hidden';
    element.style.opacity = visible ? '1' : '0';
    if (visible) {
      const age = Math.max(0, timeMs - active.fromMs);
      const p = 1 - Math.pow(1 - Math.min(1, age / 180), 3);
      const line = element.firstElementChild;
      if (line) line.style.transform = `translateY(${(1 - p) * 12}px)`;
    }
  }
  return active;
}
