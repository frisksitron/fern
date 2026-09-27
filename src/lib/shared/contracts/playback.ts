import { Schema } from 'effect';
import { HlsSessionId, MediaEntryId, SubtitleId } from './ids';

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const OptionalPositive = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));

/** An audio, video, or subtitle stream found by ffprobe. */
export const MediaTrack = Schema.Struct({
  streamIndex: Index,
  kind: Schema.Literals(['video', 'audio', 'subtitle']),
  codec: Schema.String,
  language: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  isDefault: Schema.Boolean,
  isForced: Schema.Boolean,
  channels: OptionalPositive,
  channelLayout: Schema.NullOr(Schema.String),
  bitrate: OptionalPositive,
  sampleRate: OptionalPositive,
  bitDepth: OptionalPositive,
  width: OptionalPositive,
  height: OptionalPositive,
});
export type MediaTrack = typeof MediaTrack.Type;

/** A subtitle file next to the video, served as WebVTT from `/api/subtitles/:id`. */
export const ExternalSubtitle = Schema.Struct({
  kind: Schema.Literal('external'),
  id: SubtitleId,
  name: Schema.String,
  format: Schema.Literals(['srt', 'vtt']),
  language: Schema.NullOr(Schema.String),
});
export type ExternalSubtitle = typeof ExternalSubtitle.Type;

export const SubtitleTrack = Schema.Union([MediaTrack, ExternalSubtitle]);
export type SubtitleTrack = typeof SubtitleTrack.Type;

const PlayableFields = {
  durationMs: Schema.NullOr(Schema.Finite),
  audioTracks: Schema.Array(MediaTrack),
  subtitleTracks: Schema.Array(SubtitleTrack),
};

/** `GET /api/playback/:id/plan`. */
export const PlaybackPlan = Schema.Union([
  Schema.Struct({ mode: Schema.Literal('direct'), url: Schema.String, ...PlayableFields }),
  Schema.Struct({ mode: Schema.Literal('hls'), sessionUrl: Schema.String, ...PlayableFields }),
  Schema.Struct({ mode: Schema.Literal('unplayable'), reason: Schema.String }),
]);
export type PlaybackPlan = typeof PlaybackPlan.Type;

/** Codec support reported by the client with `?h264=false` and similar; absent means supported. */
export type PlaybackCapabilities = { readonly h264: boolean; readonly aac: boolean; readonly webm: boolean };

/** `POST /api/playback/:id/session` body. Without `audioStream`, the default audio track is used. */
export const CreateHlsSessionRequest = Schema.Struct({ audioStream: Schema.optionalKey(Schema.NullOr(Index)) });
export type CreateHlsSessionRequest = typeof CreateHlsSessionRequest.Type;

export const HlsSession = Schema.Struct({ sessionId: HlsSessionId, manifestUrl: Schema.String });
export type HlsSession = typeof HlsSession.Type;

/** `session.json` in an HLS cache directory. Read back from disk, so it is decoded, not trusted. */
export const HlsSessionMetadata = Schema.Struct({
  mediaId: MediaEntryId,
  audioStream: Schema.NullOr(Index),
  durationMs: Schema.Finite.check(Schema.isGreaterThan(0)),
  size: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  mtimeMs: Schema.Finite,
  accelerator: Schema.Literals(['nvenc', 'qsv', 'software']),
});
export type HlsSessionMetadata = typeof HlsSessionMetadata.Type;
