import { Data } from 'effect';
import type { ProcessError } from '$lib/server/media/process-runner';

export class AudioStreamNotFound extends Data.TaggedError('AudioStreamNotFound')<{
  readonly mediaId: string;
  readonly streamIndex: number;
}> {}

/** HLS manifests need the duration, which ffprobe could not determine for this file. */
export class MediaDurationUnknown extends Data.TaggedError('MediaDurationUnknown')<{ readonly mediaId: string }> {}

export class SubtitleNotFound extends Data.TaggedError('SubtitleNotFound')<{ readonly id: string }> {}

/** Image-based subtitles (such as PGS) would have to be burned into the video, which Fern does not do. */
export class SubtitleRequiresBurnIn extends Data.TaggedError('SubtitleRequiresBurnIn')<{ readonly codec: string }> {}

/** FFmpeg could not convert the embedded subtitle stream. */
export class SubtitleUnavailable extends Data.TaggedError('SubtitleUnavailable')<{ readonly cause: ProcessError }> {}
