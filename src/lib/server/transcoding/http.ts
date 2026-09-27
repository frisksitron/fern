import { mediaFailure, type MediaFailure } from '$lib/server/media/http';
import type { CapacityExceeded } from '$lib/server/media/work';
import type { PublicError } from '$lib/server/public-errors';
import type { ThumbnailFailed } from '$lib/server/thumbnails/service';
import type { HlsFileNotFound, MediaChanged, TranscodeFailed, TranscodeTimedOut } from './errors';

type TranscodeFailure =
  | MediaFailure
  | HlsFileNotFound
  | MediaChanged
  | CapacityExceeded
  | TranscodeFailed
  | TranscodeTimedOut
  | ThumbnailFailed;

// Exhaustive: adding an error to the union without mapping it is a type error.
export function transcodeFailure(error: TranscodeFailure): PublicError {
  switch (error._tag) {
    case 'HlsFileNotFound':
      return { status: 404, code: 'hls.not_found', message: 'That stream file does not exist.' };
    case 'MediaChanged':
      return {
        status: 409,
        code: 'media.changed',
        message: 'This media file changed while it was playing. Start playback again.',
      };
    case 'CapacityExceeded':
      return {
        status: 503,
        code: 'transcode.capacity_exceeded',
        message: 'Fern is busy transcoding. Try again shortly.',
        headers: { 'retry-after': String(error.retryAfterSeconds) },
      };
    case 'TranscodeFailed':
      return { status: 500, code: 'transcode.failed', message: 'This part of the media could not be transcoded.' };
    case 'TranscodeTimedOut':
      return { status: 504, code: 'transcode.timed_out', message: 'Transcoding took too long.' };
    case 'ThumbnailFailed':
      return { status: 404, code: 'thumbnail.unavailable', message: 'No thumbnail is available for this position.' };
    default:
      return mediaFailure(error);
  }
}
