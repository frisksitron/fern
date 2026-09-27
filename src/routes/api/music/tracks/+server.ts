import { Effect, Schema } from 'effect';
import type { DatabaseUnavailable } from '$lib/server/db/service';
import { decodeInput, jsonResponse, respond, type RequestInvalid } from '$lib/server/http';
import type { FolderTooLarge } from '$lib/server/library/folder-tracks';
import { MediaLibrary } from '$lib/server/media/library';
import { databaseUnavailable, requestInvalid, type PublicError } from '$lib/server/public-errors';
import { FolderTracksQuery, FolderTracksResponse } from '$lib/shared/contracts/music';
import type { RequestHandler } from './$types';

const decodeQuery = Schema.decodeUnknownEffect(FolderTracksQuery);

function failure(error: RequestInvalid | DatabaseUnavailable | FolderTooLarge): PublicError {
  switch (error._tag) {
    case 'RequestInvalid':
      return requestInvalid;
    case 'DatabaseUnavailable':
      return databaseUnavailable;
    case 'FolderTooLarge':
      return {
        status: 422,
        code: 'music.folder_too_large',
        message: `That folder has more than ${error.limit.toLocaleString('en')} tracks. Choose a smaller folder.`,
      };
  }
}

/** The tracks in a music folder and its subfolders, for adding a dragged folder to a playlist. */
export const GET: RequestHandler = ({ request, url }) =>
  respond(
    request,
    Effect.gen(function* () {
      const query = yield* decodeInput(Object.fromEntries(url.searchParams), decodeQuery);
      const ids = yield* MediaLibrary.use((library) => library.folderTracks(query.root, query.folder ?? null));
      return yield* jsonResponse(FolderTracksResponse, { ids });
    }),
    { success: (response) => response, failure },
  );
