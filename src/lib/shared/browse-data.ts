import type { MediaEntry, PlaybackProgress } from '$lib/zero/schema';
import type { MediaFolderSnapshot } from './media-folder-data';

/** A video folder, with the profile's progress on the videos in it. */
export type BrowseSnapshot = MediaFolderSnapshot & {
  folderProgress: PlaybackProgress[];
};

/** The continue-watching row: resumable videos, then up-next suggestions. */
export type ContinueWatching = {
  /** Resumable progress on videos that still exist, most recent first. */
  readonly progress: PlaybackProgress[];
  /** The videos for `progress`. */
  readonly entries: MediaEntry[];
  /** For recently finished folders, the next unwatched video, filling the row up to its limit. */
  readonly upNext: MediaEntry[];
};

/** The load dependency to invalidate when the continue-watching row may have changed. */
export const CONTINUE_WATCHING_DEPENDENCY = 'fern:continue-watching';
