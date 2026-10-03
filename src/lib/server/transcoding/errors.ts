import { Schema } from 'effect';
import { ProcessError } from '$lib/server/media/process';

/** The session or file name is invalid, the session is unknown, or the segment is out of range. */
export class HlsFileNotFound extends Schema.TaggedError<HlsFileNotFound>()('HlsFileNotFound', {
  session: Schema.String,
  file: Schema.String,
}) {}

/** The source file changed after the session started; the client should start a new session. */
export class MediaChanged extends Schema.TaggedError<MediaChanged>()('MediaChanged', { mediaId: Schema.String }) {}

/** FFmpeg failed to produce a segment, even after falling back to software encoding. */
export class TranscodeFailed extends Schema.TaggedError<TranscodeFailed>()('TranscodeFailed', {
  cause: ProcessError,
}) {}

export class TranscodeTimedOut extends Schema.TaggedError<TranscodeTimedOut>()('TranscodeTimedOut', {
  timeoutMs: Schema.Number,
}) {}
