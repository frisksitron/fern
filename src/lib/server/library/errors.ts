import { Schema } from 'effect';

/** The folder does not exist in that root, is not a folder, or its parent chain is broken. */
export class FolderNotFound extends Schema.TaggedError<FolderNotFound>()('FolderNotFound', {
  rootId: Schema.String,
  folderId: Schema.String,
}) {}

/** The playlist does not exist or belongs to another profile. */
export class PlaylistNotFound extends Schema.TaggedError<PlaylistNotFound>()('PlaylistNotFound', {
  id: Schema.String,
}) {}

export class ProfileNotFound extends Schema.TaggedError<ProfileNotFound>()('ProfileNotFound', { id: Schema.String }) {}
