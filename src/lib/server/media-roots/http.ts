import type { RequestInvalid } from '$lib/server/http';
import { databaseUnavailable, requestInvalid, type PublicError } from '$lib/server/public-errors';
import type { BrowseError, CreateMediaRootError, RemoveMediaRootError } from './errors';

// Each switch is exhaustive: adding an error to a union without mapping it is a type error.

export function browseFailure(error: BrowseError | RequestInvalid): PublicError {
  switch (error._tag) {
    case 'RequestInvalid':
      return requestInvalid;
    case 'InvalidPath':
      return { status: 400, code: 'filesystem.path_invalid', message: 'Choose an absolute folder path.' };
    case 'NotADirectory':
      return { status: 400, code: 'filesystem.not_a_directory', message: 'That path is not a folder.' };
    case 'PathNotFound':
      return { status: 404, code: 'filesystem.not_found', message: 'That folder does not exist.' };
    case 'PathAccessDenied':
      return {
        status: 403,
        code: 'filesystem.access_denied',
        message: 'Fern does not have permission to read that folder.',
      };
    case 'OutsideBrowseBoundary':
      return {
        status: 403,
        code: 'filesystem.outside_boundary',
        message: 'That folder is outside the locations Fern is allowed to browse.',
      };
    case 'FileSystemUnavailable':
      return { status: 503, code: 'filesystem.unavailable', message: 'That folder is not available right now.' };
  }
}

export function createMediaRootFailure(error: CreateMediaRootError | RequestInvalid): PublicError {
  switch (error._tag) {
    case 'MediaRootOverlap':
      return { status: 409, code: 'media_root.overlap', message: 'Media folders cannot overlap.' };
    case 'DatabaseUnavailable':
      return databaseUnavailable;
    default:
      return browseFailure(error);
  }
}

export function removeMediaRootFailure(error: RemoveMediaRootError | RequestInvalid): PublicError {
  switch (error._tag) {
    case 'RequestInvalid':
      return requestInvalid;
    case 'DatabaseUnavailable':
      return databaseUnavailable;
    case 'MediaRootNotFound':
      return { status: 404, code: 'media_root.not_found', message: 'That media folder no longer exists.' };
    case 'MediaRootBusy':
      return {
        status: 409,
        code: 'media_root.scan_active',
        message: 'A scan is running. Remove the folder when it finishes.',
      };
    case 'MediaRootManaged':
      return { status: 409, code: 'media_root.managed', message: 'Fern’s YouTube library cannot be removed.' };
  }
}
