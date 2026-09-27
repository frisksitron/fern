import { Data, Duration, Effect, Schema } from 'effect';
import { MediaProcessRunner, type ProcessError } from './process-runner';

export type NormalizedTrack = {
  streamIndex: number;
  kind: 'video' | 'audio' | 'subtitle';
  codec: string;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  channels: number | null;
  channelLayout: string | null;
  bitrate: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
  width: number | null;
  height: number | null;
};

export type ProbeResult = {
  durationMs: number | null;
  container: string | null;
  videoCodec: string | null;
  audioCodecSummary: string | null;
  audioBitrate: number | null;
  audioSampleRate: number | null;
  audioBitDepth: number | null;
  audioChannels: number | null;
  audioChannelLayout: string | null;
  width: number | null;
  height: number | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNumber: number | null;
  tracks: NormalizedTrack[];
};

/** ffprobe could not read the file, or its output was not the JSON Fern expects. */
export class ProbeFailed extends Data.TaggedError('ProbeFailed')<{
  readonly path: string;
  readonly cause: ProcessError | Schema.SchemaError;
}> {}

// ffprobe prints some numbers as strings (bit_rate, sample_rate) and others as numbers (channels,
// width); normalization accepts either. Unknown fields are ignored.
const Scalar = Schema.Union([Schema.String, Schema.Number]);
const Tags = Schema.Record(Schema.String, Schema.String);

const FfprobeStream = Schema.Struct({
  index: Schema.Number,
  codec_type: Schema.optionalKey(Schema.String),
  codec_name: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Tags),
  disposition: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
  channels: Schema.optionalKey(Scalar),
  channel_layout: Schema.optionalKey(Schema.String),
  bit_rate: Schema.optionalKey(Scalar),
  sample_rate: Schema.optionalKey(Scalar),
  bits_per_raw_sample: Schema.optionalKey(Scalar),
  bits_per_sample: Schema.optionalKey(Scalar),
  width: Schema.optionalKey(Schema.Number),
  height: Schema.optionalKey(Schema.Number),
});

const FfprobeOutput = Schema.Struct({
  format: Schema.optionalKey(
    Schema.Struct({
      duration: Schema.optionalKey(Scalar),
      format_name: Schema.optionalKey(Schema.String),
      bit_rate: Schema.optionalKey(Scalar),
      tags: Schema.optionalKey(Tags),
    }),
  ),
  streams: Schema.optionalKey(Schema.Array(FfprobeStream)),
});
type FfprobeOutput = typeof FfprobeOutput.Type;

const decodeFfprobeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(FfprobeOutput));

function positiveInteger(value: unknown) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const trackKinds = new Set(['video', 'audio', 'subtitle']);

/** Turns decoded ffprobe output into the metadata Fern stores. */
function normalizeProbe(output: FfprobeOutput): ProbeResult {
  const tracks: NormalizedTrack[] = (output.streams ?? [])
    .filter((stream) => trackKinds.has(stream.codec_type ?? ''))
    .map((stream) => ({
      streamIndex: stream.index,
      kind: stream.codec_type as NormalizedTrack['kind'],
      codec: stream.codec_name ?? 'unknown',
      language: stream.tags?.language ?? null,
      title: stream.tags?.title ?? null,
      isDefault: stream.disposition?.default === 1,
      isForced: stream.disposition?.forced === 1,
      channels: positiveInteger(stream.channels),
      channelLayout: stream.channel_layout ?? null,
      bitrate: positiveInteger(stream.bit_rate),
      sampleRate: positiveInteger(stream.sample_rate),
      bitDepth: positiveInteger(stream.bits_per_raw_sample) ?? positiveInteger(stream.bits_per_sample),
      width: stream.width ?? null,
      height: stream.height ?? null,
    }));
  const video = tracks.find((track) => track.kind === 'video');
  const audioTracks = tracks.filter((track) => track.kind === 'audio');
  const audio = audioTracks.find((track) => track.isDefault) ?? audioTracks[0];
  const tags = Object.fromEntries(
    Object.entries(output.format?.tags ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const trackNumber = Number.parseInt(tags.track?.split('/')[0] ?? '', 10);
  const duration = Number(output.format?.duration);
  return {
    durationMs: output.format?.duration !== undefined && Number.isFinite(duration) ? Math.round(duration * 1000) : null,
    container: output.format?.format_name?.split(',')[0] ?? null,
    videoCodec: video?.codec ?? null,
    audioCodecSummary: [...new Set(audioTracks.map((track) => track.codec))].join(',') || null,
    audioBitrate: audio?.bitrate ?? (!video ? positiveInteger(output.format?.bit_rate) : null),
    audioSampleRate: audio?.sampleRate ?? null,
    audioBitDepth: audio?.bitDepth ?? null,
    audioChannels: audio?.channels ?? null,
    audioChannelLayout: audio?.channelLayout ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    title: tags.title ?? null,
    artist: tags.artist ?? null,
    album: tags.album ?? null,
    albumArtist: tags.album_artist ?? tags.albumartist ?? null,
    trackNumber: Number.isFinite(trackNumber) ? trackNumber : null,
    tracks,
  };
}

/** Runs ffprobe on a file and decodes its JSON output. */
export function probeMedia(file: string, timeout: Duration.Input = '30 seconds') {
  return Effect.gen(function* () {
    const runner = yield* MediaProcessRunner;
    const { stdout } = yield* runner.run({
      program: 'ffprobe',
      args: ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      timeout,
      maxStdoutBytes: 10_000_000,
    });
    return normalizeProbe(yield* decodeFfprobeJson(stdout.toString('utf8')));
  }).pipe(
    Effect.mapError((cause) => new ProbeFailed({ path: file, cause })),
    Effect.withSpan('media.probe'),
  );
}
