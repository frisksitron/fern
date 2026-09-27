import { mediaFailure, type MediaFailure } from '$lib/server/media/http';
import type { CapacityExceeded } from '$lib/server/media/work';
import type { PublicError } from '$lib/server/public-errors';
import type {
  AudioStreamNotFound,
  MediaDurationUnknown,
  SubtitleNotFound,
  SubtitleRequiresBurnIn,
  SubtitleUnavailable,
} from './errors';

type PlaybackFailure =
  | MediaFailure
  | AudioStreamNotFound
  | MediaDurationUnknown
  | SubtitleNotFound
  | SubtitleRequiresBurnIn
  | SubtitleUnavailable
  | CapacityExceeded;

// Exhaustive: adding an error to the union without mapping it is a type error.
export function playbackFailure(error: PlaybackFailure): PublicError {
  switch (error._tag) {
    case 'AudioStreamNotFound':
      return { status: 404, code: 'playback.audio_stream_not_found', message: 'That audio track does not exist.' };
    case 'MediaDurationUnknown':
      return {
        status: 422,
        code: 'media.duration_unknown',
        message: 'This media cannot be streamed because its duration is unknown.',
      };
    case 'SubtitleNotFound':
      return { status: 404, code: 'subtitle.not_found', message: 'That subtitle does not exist.' };
    case 'SubtitleRequiresBurnIn':
      return {
        status: 422,
        code: 'subtitle.requires_burn_in',
        message: 'This image subtitle requires burn-in, which is not available in this build.',
      };
    case 'SubtitleUnavailable':
      return { status: 422, code: 'subtitle.unavailable', message: 'This subtitle could not be converted.' };
    case 'CapacityExceeded':
      return {
        status: 503,
        code: 'subtitle.busy',
        message: 'Fern is busy converting subtitles. Try again shortly.',
        headers: { 'retry-after': String(error.retryAfterSeconds) },
      };
    default:
      return mediaFailure(error);
  }
}
