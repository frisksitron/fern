import { Schema } from 'effect';
import type { FileSystemUnavailable, PathAccessDenied } from '$lib/server/platform/disk';

/** No active, playable media entry has this ID. */
export class MediaNotFound extends Schema.TaggedError<MediaNotFound>()('MediaNotFound', { id: Schema.String }) {}

/** The indexed file is gone, is no longer a regular file, or resolves outside its media root. */
export class MediaFileUnavailable extends Schema.TaggedError<MediaFileUnavailable>()('MediaFileUnavailable', {
  path: Schema.String,
  reason: Schema.Literals(['missing', 'not-a-file', 'outside-root']),
}) {}

export type MediaFileError = MediaFileUnavailable | PathAccessDenied | FileSystemUnavailable;

/** The entry is not a song or folder with indexed artwork, or the artwork file is no longer indexed. */
export class ArtworkNotFound extends Schema.TaggedError<ArtworkNotFound>()('ArtworkNotFound', { id: Schema.String }) {}
