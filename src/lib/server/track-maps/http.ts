import { mediaFailure, type MediaFailure } from '$lib/server/media/http';
import type { CapacityExceeded } from '$lib/server/media/work';
import type { PublicError } from '$lib/server/public-errors';
import type { TrackMapFailed } from './service';

type TrackMapFailure = MediaFailure | CapacityExceeded | TrackMapFailed;

// Exhaustive: adding an error to the union without mapping it is a type error.
export function trackMapFailure(error: TrackMapFailure): PublicError {
  switch (error._tag) {
    case 'CapacityExceeded':
      return {
        status: 503,
        code: 'track_map.busy',
        message: 'Fern is busy reading other songs. Try again shortly.',
        headers: { 'retry-after': String(error.retryAfterSeconds) },
      };
    case 'TrackMapFailed':
      return { status: 404, code: 'track_map.unavailable', message: 'This track could not be analysed.' };
    default:
      return mediaFailure(error);
  }
}
