/**
 * The single source of Fern's watched and resume rules. Every surface (Zero queries and mutators,
 * browse loaders, the watch page, and MCP) uses these constants and functions.
 */

/** Progress below this is treated as not started: nothing to resume and not "continue watching". */
export const RESUME_MIN_MS = 1_000;

/** Media counts as watched once this fraction of it has been played… */
const WATCHED_RATIO = 0.9;

/** …or, for media at least twice this long, once playback is within this much of the end. */
const WATCHED_END_MARGIN_MS = 120_000;

/** How many items the continue-watching row shows (in-progress items first, then up next). */
export const CONTINUE_WATCHING_LIMIT = 30;

type ProgressState = { readonly positionMs: number; readonly watched: boolean | null };

export function isWatched(positionMs: number, durationMs: number | null): boolean {
  if (!durationMs || durationMs <= 0) return false;
  return (
    positionMs / durationMs >= WATCHED_RATIO ||
    (durationMs >= WATCHED_END_MARGIN_MS * 2 && durationMs - positionMs <= WATCHED_END_MARGIN_MS)
  );
}

/**
 * Whether saved progress should resume playback and appear under "Continue watching". The
 * `continueWatching` Zero query expresses the same rule in ZQL.
 */
export function hasResumableProgress(progress: ProgressState | null | undefined): boolean {
  return !!progress && !progress.watched && progress.positionMs >= RESUME_MIN_MS;
}
