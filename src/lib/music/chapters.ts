/** What the player needs of a chapter (see `media_chapters`). */
export type Chapter = { readonly startMs: number; readonly endMs: number; readonly title: string | null };

/** Within this much of a chapter's start, "previous" goes to the chapter before rather than back to its start. */
const RESTART_WINDOW_MS = 3000;

/** The chapter playing at `positionMs`, or -1 before the first one (or without any). */
export function chapterIndexAt(chapters: readonly Chapter[], positionMs: number) {
  let index = -1;
  for (let at = 0; at < chapters.length && chapters[at]!.startMs <= positionMs; at++) index = at;
  return index;
}

/** Where "next" goes: the next chapter's start, or null in the last one (the next song plays instead). */
export function nextChapterStart(chapters: readonly Chapter[], positionMs: number) {
  return chapters[chapterIndexAt(chapters, positionMs) + 1]?.startMs ?? null;
}

/**
 * Where "previous" goes, like previous for songs: back to the start of the playing chapter, or to
 * the chapter before when it has only just started. Null in the first chapter's opening seconds
 * (the previous song plays instead).
 */
export function previousChapterStart(chapters: readonly Chapter[], positionMs: number) {
  const index = chapterIndexAt(chapters, positionMs);
  if (index < 0) return null;
  if (positionMs - chapters[index]!.startMs > RESTART_WINDOW_MS) return chapters[index]!.startMs;
  return index > 0 ? chapters[index - 1]!.startMs : null;
}

/** `m:ss`, or `h:mm:ss` from an hour, for chapter starts and the player's clock. */
export function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
