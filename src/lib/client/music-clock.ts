/**
 * The music's clock for the visual effect: on every animation frame, where the player's `<audio>`
 * element is in the song. The effect is worked out from the song ahead of time and drawn from the
 * position alone, so it needs nothing else from the audio.
 */

let element: HTMLAudioElement | null = null;

/** The player registers its `<audio>` element. */
export function registerMusicClock(audio: HTMLAudioElement | null) {
  element = audio;
}

/** Seconds into the playing track. */
let position = 0;

/**
 * `currentTime` moves in uneven steps from frame to frame, so while playing the position runs on
 * the frame clock and eases towards it; paused, or after a seek, it is exact.
 */
function follow(seconds: number) {
  const current = element?.currentTime ?? 0;
  if (!element || element.paused || Math.abs(current - position) > 0.1) return current;
  const next = position + seconds * element.playbackRate;
  return next + (current - next) * 0.1;
}

type Listener = (position: number) => void;
const listeners = new Set<Listener>();
let animation = 0;
let previousAt = 0;

function tick(now: number) {
  // A frame counts for a tenth of a second at most, so a background tab does not jump.
  position = follow(Math.min(0.1, Math.max(0, (now - previousAt) / 1000)));
  previousAt = now;
  for (const listener of listeners) listener(position);
  animation = requestAnimationFrame(tick);
}

/** Calls `listener` on every animation frame with the position, in seconds into the playing track; returns an unsubscribe. */
export function onClockFrame(listener: Listener) {
  listeners.add(listener);
  if (listeners.size === 1) {
    previousAt = performance.now();
    animation = requestAnimationFrame(tick);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) cancelAnimationFrame(animation);
  };
}
