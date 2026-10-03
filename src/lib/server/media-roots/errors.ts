import { Data } from 'effect';
import type { DatabaseUnavailable } from '$lib/server/db/service';
import type { FileSystemError } from '$lib/server/platform/filesystem';

/** The path is relative or contains a NUL byte. */
export class InvalidPath extends Data.TaggedError('InvalidPath')<{ readonly path: string }> {}
export class NotADirectory extends Data.TaggedError('NotADirectory')<{ readonly path: string }> {}
/** `BROWSE_ROOTS` is configured and the canonical path is not inside any of them. */
export class OutsideBrowseBoundary extends Data.TaggedError('OutsideBrowseBoundary')<{ readonly path: string }> {}
export class MediaRootOverlap extends Data.TaggedError('MediaRootOverlap')<{
  readonly path: string;
  /** The existing root that equals or contains the new one (or is inside it), when known. */
  readonly conflictingRootId: string | null;
}> {}

export type BrowseError = InvalidPath | NotADirectory | OutsideBrowseBoundary | FileSystemError;
export type CreateMediaRootError = BrowseError | MediaRootOverlap | DatabaseUnavailable;

export class MediaRootNotFound extends Data.TaggedError('MediaRootNotFound')<{ readonly id: string }> {}

/** A scan is active, so the root cannot be removed until it finishes. */
export class MediaRootBusy extends Data.TaggedError('MediaRootBusy')<{ readonly id: string }> {}

/** The root is Fern's own (the YouTube library), not a folder a user added, so it cannot be removed. */
export class MediaRootManaged extends Data.TaggedError('MediaRootManaged')<{ readonly id: string }> {}

export type RemoveMediaRootError = MediaRootNotFound | MediaRootBusy | MediaRootManaged | DatabaseUnavailable;
