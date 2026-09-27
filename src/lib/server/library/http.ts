import { Effect, Schema } from 'effect';
import type { DatabaseUnavailable } from '$lib/server/db/service';
import type { LoadFailure } from '$lib/server/http';
import { MediaRootNotFound } from '$lib/server/media-roots/errors';
import { databaseUnavailable } from '$lib/server/public-errors';
import { MediaEntryId, MediaRootId, PlaylistId } from '$lib/shared/contracts/ids';
import { FolderNotFound, PlaylistNotFound } from './errors';

type LibraryPageFailure = MediaRootNotFound | FolderNotFound | PlaylistNotFound | DatabaseUnavailable;

/**
 * How library pages present failures: an unknown root goes back to the section, an unknown folder
 * to its root, and an unknown playlist to the music home page.
 */
export function libraryPageFailure(section: '/browse' | '/music') {
  // Exhaustive: adding an error to the union without mapping it is a type error.
  return (error: LibraryPageFailure): LoadFailure => {
    switch (error._tag) {
      case 'MediaRootNotFound':
        return { redirect: section };
      case 'FolderNotFound':
        return { redirect: `${section}/${error.rootId}` };
      case 'PlaylistNotFound':
        return { redirect: '/music' };
      case 'DatabaseUnavailable':
        return databaseUnavailable;
    }
  };
}

// Route parameters are decoded at the edge. A malformed ID names nothing, so it fails the same
// way an unknown one does.

export const rootParam = (value: string) =>
  Schema.decodeUnknownEffect(MediaRootId)(value).pipe(Effect.mapError(() => new MediaRootNotFound({ id: value })));

export const folderParam = (rootId: MediaRootId, value: string) =>
  Schema.decodeUnknownEffect(MediaEntryId)(value).pipe(
    Effect.mapError(() => new FolderNotFound({ rootId, folderId: value })),
  );

export const playlistParam = (value: string) =>
  Schema.decodeUnknownEffect(PlaylistId)(value).pipe(Effect.mapError(() => new PlaylistNotFound({ id: value })));
