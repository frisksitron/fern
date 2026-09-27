import { Data } from 'effect';
import type { FileSystemUnavailable, PathAccessDenied } from '$lib/server/platform/filesystem';

/** No active, playable media entry has this ID. */
export class MediaNotFound extends Data.TaggedError('MediaNotFound')<{ readonly id: string }> {}

/** The indexed file is gone, is no longer a regular file, or resolves outside its media root. */
export class MediaFileUnavailable extends Data.TaggedError('MediaFileUnavailable')<{
  readonly path: string;
  readonly reason: 'missing' | 'not-a-file' | 'outside-root';
}> {}

export type MediaFileError = MediaFileUnavailable | PathAccessDenied | FileSystemUnavailable;

/** The entry is not a song or folder with indexed artwork, or the artwork file is no longer indexed. */
export class ArtworkNotFound extends Data.TaggedError('ArtworkNotFound')<{ readonly id: string }> {}
