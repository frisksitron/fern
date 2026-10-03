import { Schema } from 'effect';
import { ProcessError } from '$lib/server/media/process';

export class AudioStreamNotFound extends Schema.TaggedError<AudioStreamNotFound>()('AudioStreamNotFound', {
  mediaId: Schema.String,
  streamIndex: Schema.Number,
}) {}

/** HLS manifests need the duration, which ffprobe could not determine for this file. */
export class MediaDurationUnknown extends Schema.TaggedError<MediaDurationUnknown>()('MediaDurationUnknown', {
  mediaId: Schema.String,
}) {}

export class SubtitleNotFound extends Schema.TaggedError<SubtitleNotFound>()('SubtitleNotFound', {
  id: Schema.String,
}) {}

/** Image-based subtitles (such as PGS) would have to be burned into the video, which Fern does not do. */
export class SubtitleRequiresBurnIn extends Schema.TaggedError<SubtitleRequiresBurnIn>()('SubtitleRequiresBurnIn', {
  codec: Schema.String,
}) {}

/** FFmpeg could not convert the embedded subtitle stream. */
export class SubtitleUnavailable extends Schema.TaggedError<SubtitleUnavailable>()('SubtitleUnavailable', {
  cause: ProcessError,
}) {}
