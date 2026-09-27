import type { DatabaseUnavailable } from '$lib/server/db/service';
import type { RequestInvalid } from '$lib/server/http';
import type { MediaRootNotFound } from '$lib/server/media-roots/errors';
import { databaseUnavailable, requestInvalid, type PublicError } from '$lib/server/public-errors';
import type { ScanAlreadyRunning, ScanNotFound } from './errors';

type ScanFailure = ScanNotFound | ScanAlreadyRunning | MediaRootNotFound | DatabaseUnavailable | RequestInvalid;

// Exhaustive: adding an error to the union without mapping it is a type error.
export function scanFailure(error: ScanFailure): PublicError {
  switch (error._tag) {
    case 'RequestInvalid':
      return requestInvalid;
    case 'DatabaseUnavailable':
      return databaseUnavailable;
    case 'ScanNotFound':
      return { status: 404, code: 'scan.not_found', message: 'That scan does not exist.' };
    case 'ScanAlreadyRunning':
      return { status: 409, code: 'scan.already_running', message: 'A scan is already running.' };
    case 'MediaRootNotFound':
      return { status: 404, code: 'media_root.not_found', message: 'That media folder no longer exists.' };
  }
}
