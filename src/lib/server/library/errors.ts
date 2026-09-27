import { Data } from 'effect';

/** The folder does not exist in that root, is not a folder, or its parent chain is broken. */
export class FolderNotFound extends Data.TaggedError('FolderNotFound')<{
  readonly rootId: string;
  readonly folderId: string;
}> {}

/** The playlist does not exist or belongs to another profile. */
export class PlaylistNotFound extends Data.TaggedError('PlaylistNotFound')<{ readonly id: string }> {}

export class ProfileNotFound extends Data.TaggedError('ProfileNotFound')<{ readonly id: string }> {}
