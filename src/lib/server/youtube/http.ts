import type { DatabaseUnavailable } from '$lib/server/db/service';
import type { RequestInvalid } from '$lib/server/http';
import { databaseUnavailable, requestInvalid, type PublicError } from '$lib/server/public-errors';
import type {
  InvalidYouTubeUrl,
  YouTubeDownloadActive,
  YouTubeDownloadNotFailed,
  YouTubeDownloadNotFound,
  YouTubeLibraryUnavailable,
} from './errors';

type YouTubeError =
  | RequestInvalid
  | DatabaseUnavailable
  | InvalidYouTubeUrl
  | YouTubeDownloadActive
  | YouTubeDownloadNotFound
  | YouTubeDownloadNotFailed
  | YouTubeLibraryUnavailable;

// Exhaustive: adding an error to the union without mapping it is a type error.
export function youtubeFailure(error: YouTubeError): PublicError {
  switch (error._tag) {
    case 'RequestInvalid':
      return requestInvalid;
    case 'DatabaseUnavailable':
      return databaseUnavailable;
    case 'InvalidYouTubeUrl':
      return { status: 400, code: 'youtube.url_invalid', message: 'Paste a link to one YouTube video.' };
    case 'YouTubeDownloadActive':
      return { status: 409, code: 'youtube.already_downloading', message: 'That video is already being downloaded.' };
    case 'YouTubeDownloadNotFound':
      return { status: 404, code: 'youtube.download_not_found', message: 'That download no longer exists.' };
    case 'YouTubeDownloadNotFailed':
      return { status: 409, code: 'youtube.download_not_failed', message: 'Only failed downloads can be retried.' };
    case 'YouTubeLibraryUnavailable':
      return {
        status: 503,
        code: 'youtube.library_unavailable',
        message: 'The YouTube library is unavailable. Check that its folder can be written.',
      };
  }
}
