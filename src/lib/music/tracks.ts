import type { MediaEntry } from '$lib/zero/schema';

export function trackTitle(track: Pick<MediaEntry, 'title' | 'name'>) {
  return track.title ?? track.name.replace(/\.[^.]+$/, '');
}

export function formatDuration(milliseconds: number | null) {
  if (!milliseconds) return '—';
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A list's total length, such as `42 min` or `1 h 5 min`. */
export function formatTotalDuration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Where a track's folder is in the music browser. */
export function trackFolderHref(track: Pick<MediaEntry, 'mediaRootId' | 'parentId'>) {
  return track.parentId ? `/music/${track.mediaRootId}/${track.parentId}` : `/music/${track.mediaRootId}`;
}
