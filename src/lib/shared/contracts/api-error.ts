import { Option, Schema } from 'effect';

/**
 * Stable public error codes. Clients may branch on `code`; `message` is safe to display and never
 * contains filesystem paths, SQL, or process output.
 */
export const ApiErrorCode = Schema.Literals([
  'request.invalid',
  'request.cancelled',
  'service.unavailable',
  'internal',
  'database.unavailable',
  'filesystem.path_invalid',
  'filesystem.not_found',
  'filesystem.not_a_directory',
  'filesystem.access_denied',
  'filesystem.outside_boundary',
  'filesystem.unavailable',
  'media_root.overlap',
  'media_root.not_found',
  'media_root.scan_active',
  'media.not_found',
  'media.file_missing',
  'media.duration_unknown',
  'artwork.not_found',
  'playback.audio_stream_not_found',
  'subtitle.not_found',
  'subtitle.requires_burn_in',
  'subtitle.unavailable',
  'subtitle.busy',
  'hls.not_found',
  'media.changed',
  'transcode.capacity_exceeded',
  'transcode.failed',
  'transcode.timed_out',
  'thumbnail.unavailable',
  'music.folder_too_large',
  'scan.not_found',
  'scan.already_running',
]);
export type ApiErrorCode = typeof ApiErrorCode.Type;

export const ApiErrorBody = Schema.Struct({ code: ApiErrorCode, message: Schema.String });
export type ApiErrorBody = typeof ApiErrorBody.Type;

const decodeApiError = Schema.decodeUnknownOption(ApiErrorBody);

/** The error body of a failed API response, or null when the body is not one. */
export function readApiError(value: unknown): ApiErrorBody | null {
  return Option.getOrNull(decodeApiError(value));
}
