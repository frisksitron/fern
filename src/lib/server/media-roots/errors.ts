import { Schema } from 'effect';
import type { DatabaseUnavailable } from '$lib/server/db/service';
import type { FileSystemError } from '$lib/server/platform/disk';

/** The path is relative or contains a NUL byte. */
export class InvalidPath extends Schema.TaggedError<InvalidPath>()('InvalidPath', { path: Schema.String }) {}

export class NotADirectory extends Schema.TaggedError<NotADirectory>()('NotADirectory', { path: Schema.String }) {}

/** `BROWSE_ROOTS` is configured and the canonical path is not inside any of them. */
export class OutsideBrowseBoundary extends Schema.TaggedError<OutsideBrowseBoundary>()('OutsideBrowseBoundary', {
  path: Schema.String,
}) {}

export class MediaRootOverlap extends Schema.TaggedError<MediaRootOverlap>()('MediaRootOverlap', {
  path: Schema.String,
  /** The existing root that equals or contains the new one (or is inside it), when known. */
  conflictingRootId: Schema.NullOr(Schema.String),
}) {}

export class MediaRootNotFound extends Schema.TaggedError<MediaRootNotFound>()('MediaRootNotFound', {
  id: Schema.String,
}) {}

/** A scan is active, so the root cannot be removed until it finishes. */
export class MediaRootBusy extends Schema.TaggedError<MediaRootBusy>()('MediaRootBusy', { id: Schema.String }) {}

/** The root is Fern's own (the YouTube library), not a folder a user added, so it cannot be removed. */
export class MediaRootManaged extends Schema.TaggedError<MediaRootManaged>()('MediaRootManaged', {
  id: Schema.String,
}) {}

export type BrowseError = InvalidPath | NotADirectory | OutsideBrowseBoundary | FileSystemError;
export type CreateMediaRootError = BrowseError | MediaRootOverlap | DatabaseUnavailable;
export type RemoveMediaRootError = MediaRootNotFound | MediaRootBusy | MediaRootManaged | DatabaseUnavailable;
