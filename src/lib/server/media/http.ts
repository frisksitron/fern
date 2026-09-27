import type { DatabaseUnavailable } from '$lib/server/db/service';
import type { RequestInvalid } from '$lib/server/http';
import { databaseUnavailable, requestInvalid, type PublicError } from '$lib/server/public-errors';
import type { ArtworkNotFound, MediaFileError, MediaNotFound } from './errors';

export type MediaFailure = MediaNotFound | MediaFileError | ArtworkNotFound | DatabaseUnavailable | RequestInvalid;

// Exhaustive: adding an error to the union without mapping it is a type error.
export function mediaFailure(error: MediaFailure): PublicError {
  switch (error._tag) {
    case 'RequestInvalid':
      return requestInvalid;
    case 'DatabaseUnavailable':
      return databaseUnavailable;
    case 'MediaNotFound':
      return { status: 404, code: 'media.not_found', message: 'This media is no longer available.' };
    case 'MediaFileUnavailable':
      return { status: 404, code: 'media.file_missing', message: 'The media file could not be found.' };
    case 'PathAccessDenied':
      return {
        status: 403,
        code: 'filesystem.access_denied',
        message: 'Fern does not have permission to read this media.',
      };
    case 'FileSystemUnavailable':
      return { status: 503, code: 'filesystem.unavailable', message: 'This media is not available right now.' };
    case 'ArtworkNotFound':
      return { status: 404, code: 'artwork.not_found', message: 'No artwork is available.' };
  }
}
