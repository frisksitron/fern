/** Songs shorter than this never count as played. */
export const PLAY_MIN_TRACK_MS = 30_000;

/** Listening this long always counts, however long the song is. */
export const PLAY_MAX_LISTEN_MS = 240_000;

/**
 * How far the playhead may run ahead of the clock between two updates and still count as
 * listening. Events arrive a little late or early, so the playhead and the clock never agree exactly.
 */
const CLOCK_TOLERANCE_MS = 500;

/**
 * How long a song must actually be listened to before it counts as a play: half of it, or four
 * minutes, whichever comes first. `null` when the song is too short to count (or its length is unknown).
 */
export function playThresholdMs(durationMs: number | null) {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < PLAY_MIN_TRACK_MS) return null;
  return Math.min(durationMs / 2, PLAY_MAX_LISTEN_MS);
}

/**
 * Counts listening time for one play of one song and reports once when it becomes a play.
 *
 * Between two playhead updates, the time listened is how far the playhead moved, but never more
 * than the clock allows at the playback rate. Updates may be far apart (browsers throttle them in
 * background tabs) and still count in full, while a jump ahead (a seek) adds only the time that
 * really passed, so skipping to the end of a song does not count it.
 */
export class PlayCounter {
  #listenedMs = 0;
  #last: { positionMs: number; clockMs: number } | null = null;
  #counted = false;

  /** Starts a new play: the song was loaded, or started over. */
  reset() {
    this.#listenedMs = 0;
    this.#last = null;
    this.#counted = false;
  }

  /** Playback paused or was seeked: the next update starts a new stretch of listening. */
  interrupt() {
    this.#last = null;
  }

  /**
   * Records the playhead while the song plays, at `clockMs` on a monotonic clock such as
   * `performance.now()`. Returns true exactly once per play, on the update that reaches the
   * threshold for a song of `durationMs`.
   */
  advance(positionMs: number, clockMs: number, durationMs: number | null, playbackRate = 1) {
    if (this.#last) {
      const movedMs = positionMs - this.#last.positionMs;
      const allowedMs = (clockMs - this.#last.clockMs) * playbackRate + CLOCK_TOLERANCE_MS;
      if (movedMs > 0) this.#listenedMs += Math.min(movedMs, allowedMs);
    }
    this.#last = { positionMs, clockMs };
    const thresholdMs = playThresholdMs(durationMs);
    if (this.#counted || thresholdMs === null || this.#listenedMs < thresholdMs) return false;
    this.#counted = true;
    return true;
  }
}
