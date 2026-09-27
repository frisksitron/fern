import { Data } from 'effect';
import type { ProcessError } from '$lib/server/media/process-runner';

/** The session or file name is invalid, the session is unknown, or the segment is out of range. */
export class HlsFileNotFound extends Data.TaggedError('HlsFileNotFound')<{
  readonly session: string;
  readonly file: string;
}> {}

/** The source file changed after the session started; the client should start a new session. */
export class MediaChanged extends Data.TaggedError('MediaChanged')<{ readonly mediaId: string }> {}

/** FFmpeg failed to produce a segment, even after falling back to software encoding. */
export class TranscodeFailed extends Data.TaggedError('TranscodeFailed')<{ readonly cause: ProcessError }> {}

export class TranscodeTimedOut extends Data.TaggedError('TranscodeTimedOut')<{ readonly timeoutMs: number }> {}
