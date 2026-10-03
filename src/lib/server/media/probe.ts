import { Context, Duration, Effect, Layer, Schema } from 'effect';
import { MediaProcess, ProcessExited, ProcessOutputTooLarge, ProcessSpawnFailed, ProcessTimedOut } from './process';

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

/** A named part of a file, such as one song of a DJ mix. */
export type NormalizedChapter = {
  /** The chapter's place in the file, from 0. */
  position: number;
  startMs: number;
  endMs: number;
  title: string | null;
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
  chapters: NormalizedChapter[];
};

/** ffprobe could not read the file, or its output was not the JSON Fern expects. */
export class ProbeFailed extends Schema.TaggedError<ProbeFailed>()('ProbeFailed', {
  path: Schema.String,
  cause: Schema.Union([
    ProcessSpawnFailed,
    ProcessExited,
    ProcessTimedOut,
    ProcessOutputTooLarge,
    Schema.instanceOf(Schema.SchemaError),
  ]),
}) {}

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

const FfprobeChapter = Schema.Struct({
  start_time: Scalar,
  end_time: Scalar,
  tags: Schema.optionalKey(Tags),
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
  chapters: Schema.optionalKey(Schema.Array(FfprobeChapter)),
});
type FfprobeOutput = typeof FfprobeOutput.Type;

const decodeFfprobeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(FfprobeOutput));

/** The largest value of a PostgreSQL `integer` column. */
const INT4_MAX = 2_147_483_647;

/**
 * A whole number that fits an `integer` column and its non-negative check, or null. ffprobe reports
 * values outside that range (a ProRes `bit_rate` near 2.8e9, a negative track number), and one such
 * value would fail the whole batch insert and with it every scan.
 */
function int4(value: unknown, minimum = 0) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= INT4_MAX ? parsed : null;
}

const positiveInteger = (value: unknown) => int4(value, 1);

/** Milliseconds as stored in a `bigint` column, or null when not a usable non-negative number. */
function bigintMs(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const trackKinds = new Set(['video', 'audio', 'subtitle']);

/**
 * Tags with lower-case keys. NUL characters are dropped: tags are free text from the file, and
 * PostgreSQL rejects NUL in `text`, which would fail the whole batch insert.
 */
const lowerCaseKeys = (tags: Readonly<Record<string, string>> | undefined): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).map(([key, value]) => [key.toLowerCase(), value.replaceAll('\u0000', '')]),
  );

/**
 * Chapters in playback order, without empty ones. The last chapter often ends a little after the
 * file does; it is cut at the file's duration.
 */
function normalizeChapters(chapters: FfprobeOutput['chapters'], durationMs: number | null): NormalizedChapter[] {
  return (chapters ?? [])
    .map((chapter) => {
      const endMs = Math.round(Number(chapter.end_time) * 1000);
      return {
        startMs: Math.max(0, Math.round(Number(chapter.start_time) * 1000)),
        endMs: durationMs === null ? endMs : Math.min(endMs, durationMs),
        title: lowerCaseKeys(chapter.tags).title?.trim() || null,
      };
    })
    .filter(
      (chapter) =>
        bigintMs(chapter.startMs) !== null && bigintMs(chapter.endMs) !== null && chapter.endMs > chapter.startMs,
    )
    .sort((left, right) => left.startMs - right.startMs)
    .map((chapter, position) => ({ position, ...chapter }));
}

/** Turns decoded ffprobe output into the metadata Fern stores. */
function normalizeProbe(output: FfprobeOutput): ProbeResult {
  const tracks: NormalizedTrack[] = (output.streams ?? [])
    .filter((stream) => trackKinds.has(stream.codec_type ?? '') && int4(stream.index) !== null)
    .map((stream) => ({
      streamIndex: stream.index,
      kind: stream.codec_type as NormalizedTrack['kind'],
      codec: stream.codec_name ?? 'unknown',
      language: lowerCaseKeys(stream.tags).language ?? null,
      title: lowerCaseKeys(stream.tags).title ?? null,
      isDefault: stream.disposition?.default === 1,
      isForced: stream.disposition?.forced === 1,
      channels: positiveInteger(stream.channels),
      channelLayout: stream.channel_layout ?? null,
      bitrate: positiveInteger(stream.bit_rate),
      sampleRate: positiveInteger(stream.sample_rate),
      bitDepth: positiveInteger(stream.bits_per_raw_sample) ?? positiveInteger(stream.bits_per_sample),
      width: int4(stream.width),
      height: int4(stream.height),
    }));
  const video = tracks.find((track) => track.kind === 'video');
  const audioTracks = tracks.filter((track) => track.kind === 'audio');
  const audio = audioTracks.find((track) => track.isDefault) ?? audioTracks[0];
  // Ogg files (Opus, Vorbis) keep their tags on the audio stream rather than on the file. Only
  // audio files fall back to them: a video's audio streams are titled things like "Surround 5.1".
  const audioOnly = !(output.streams ?? []).some(
    (stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1,
  );
  const audioStream = audio && output.streams?.find((stream) => stream.index === audio.streamIndex);
  const tags = {
    ...(audioOnly ? lowerCaseKeys(audioStream?.tags) : {}),
    ...lowerCaseKeys(output.format?.tags),
  };
  const trackNumber = int4(tags.track?.split('/')[0]);
  const duration = Number(output.format?.duration);
  const durationMs = output.format?.duration !== undefined ? bigintMs(Math.round(duration * 1000)) : null;
  return {
    durationMs,
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
    trackNumber,
    tracks,
    chapters: normalizeChapters(output.chapters, durationMs),
  };
}

export interface Interface {
  /** Runs ffprobe on a file and decodes its JSON output. */
  readonly probe: (file: string, timeout?: Duration.Input) => Effect.Effect<ProbeResult, ProbeFailed>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/MediaProbe') {}

/** Requires `MediaProcess`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const media = yield* MediaProcess.Service;

    const probe = Effect.fn('MediaProbe.probe')(function* (file: string, timeout: Duration.Input = '30 seconds') {
      const output = yield* media
        .run({
          program: 'ffprobe',
          args: ['-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', file],
          timeout,
          maxStdoutBytes: 10_000_000,
        })
        .pipe(Effect.mapError((cause) => new ProbeFailed({ path: file, cause })));
      return normalizeProbe(
        yield* decodeFfprobeJson(output.stdout.toString('utf8')).pipe(
          Effect.mapError((cause) => new ProbeFailed({ path: file, cause })),
        ),
      );
    });

    return Service.of({ probe });
  }),
);

export const defaultLayer = layer.pipe(Layer.provide(MediaProcess.defaultLayer));

export * as MediaProbe from './probe';
