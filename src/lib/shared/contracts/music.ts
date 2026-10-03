import { Schema } from 'effect';
import { MediaEntryId, MediaRootId } from './ids';

/** The most tracks one folder can add to a playlist at once. */
export const FOLDER_TRACK_LIMIT = 1_000;

/** `GET /api/music/tracks?root=…&folder=…`: a music folder, or a whole root without `folder`. */
export const FolderTracksQuery = Schema.Struct({
  root: MediaRootId,
  folder: Schema.optionalKey(MediaEntryId),
});

/** The folder's tracks, including those in nested folders, in album order. */
export const FolderTracksResponse = Schema.Struct({ ids: Schema.Array(MediaEntryId) });
export interface FolderTracksResponse extends Schema.Schema.Type<typeof FolderTracksResponse> {}

/** The longest playlist name, after trimming (the `playlist_name_length` check agrees). */
export const PLAYLIST_NAME_MAX_LENGTH = 80;

export const PlaylistName = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(PLAYLIST_NAME_MAX_LENGTH));
