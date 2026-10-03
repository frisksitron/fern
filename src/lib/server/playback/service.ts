import { and, eq, isNull } from 'drizzle-orm';
import { Cache, Context, Duration, Effect, Exit, Layer } from 'effect';
import { externalSubtitles, mediaEntries, mediaRoots, mediaTracks } from '$lib/server/db/schema';
import { Database, orUnavailable, type DatabaseUnavailable } from '$lib/server/db/service';
import { MediaFileUnavailable, type MediaFileError, type MediaNotFound } from '$lib/server/media/errors';
import { MediaLibrary } from '$lib/server/media/library';
import { canDirectPlay } from '$lib/server/media/playback-plan';
import { MediaProcess } from '$lib/server/media/process';
import { makeCapacity, type CapacityExceeded } from '$lib/server/media/work';
import { Disk } from '$lib/server/platform/disk';
import { Transcoding } from '$lib/server/transcoding/service';
import type { MediaEntryId, SubtitleId } from '$lib/shared/contracts/ids';
import type {
  ExternalSubtitle,
  HlsSession,
  MediaTrack,
  PlaybackCapabilities,
  PlaybackPlan,
} from '$lib/shared/contracts/playback';
import { assToVtt } from './ass';
import {
  AudioStreamNotFound,
  MediaDurationUnknown,
  SubtitleNotFound,
  SubtitleRequiresBurnIn,
  SubtitleUnavailable,
} from './errors';

type MediaLookupError = MediaNotFound | MediaFileError | DatabaseUnavailable;

/** Playback decisions for the watch page: plans, HLS sessions, and subtitles. */
export interface Interface {
  readonly plan: (
    id: MediaEntryId,
    capabilities: PlaybackCapabilities,
  ) => Effect.Effect<PlaybackPlan, MediaLookupError>;
  readonly startSession: (
    id: MediaEntryId,
    audioStream: number | null,
  ) => Effect.Effect<HlsSession, MediaLookupError | AudioStreamNotFound | MediaDurationUnknown>;
  /** A subtitle file next to the video, as WebVTT. */
  readonly externalSubtitle: (
    id: SubtitleId,
  ) => Effect.Effect<string, SubtitleNotFound | MediaFileError | DatabaseUnavailable>;
  /** An embedded text subtitle converted to WebVTT, at most a few at a time. */
  readonly embeddedSubtitle: (
    id: MediaEntryId,
    streamIndex: number,
  ) => Effect.Effect<
    string,
    MediaLookupError | SubtitleNotFound | SubtitleRequiresBurnIn | SubtitleUnavailable | CapacityExceeded
  >;
}

export class Service extends Context.Service<Service, Interface>()('@fern/Playback') {}

/** Extractions that may run at once; each reads through the whole media file. */
const SUBTITLE_EXTRACTIONS = 2;
/** Extraction always gets this long, plus the time to read the whole file at `SUBTITLE_READ_BYTES_PER_SECOND`. */
const SUBTITLE_MINIMUM_TIMEOUT_SECONDS = 60;
/** A conservative read speed for a file on a network share. */
const SUBTITLE_READ_BYTES_PER_SECOND = 25 * 1024 ** 2;
/** Converted subtitles kept in memory, so switching tracks or reloading the page does not extract again. */
const SUBTITLE_CACHE_ENTRIES = 16;
const SUBTITLE_CACHE_TTL = '30 minutes';

/** Embedded subtitle codecs FFmpeg can convert to WebVTT. */
const textSubtitleCodecs = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text']);
const assCodecs = new Set(['ass', 'ssa']);

/** One embedded subtitle stream of one version of a file. Compared by value, so it keys the cache. */
type SubtitleKey = {
  readonly file: string;
  readonly version: string;
  readonly sizeBytes: number;
  readonly stream: number;
  readonly codec: string;
};

/** FFmpeg reads through the whole file to find the subtitle packets, so a bigger file needs longer. */
export function subtitleExtractionTimeout(sizeBytes: number) {
  return Duration.seconds(SUBTITLE_MINIMUM_TIMEOUT_SECONDS + Math.ceil(sizeBytes / SUBTITLE_READ_BYTES_PER_SECOND));
}

function srtToVtt(srt: string) {
  return `WEBVTT\n\n${srt.replace(/^\uFEFF/, '').replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2')}`;
}

function toMediaTrack(row: typeof mediaTracks.$inferSelect): MediaTrack {
  return {
    streamIndex: row.streamIndex,
    kind: row.kind as MediaTrack['kind'],
    codec: row.codec,
    language: row.language,
    title: row.title,
    isDefault: row.isDefault,
    isForced: row.isForced,
    channels: row.channels,
    channelLayout: row.channelLayout,
    bitrate: row.bitrate,
    sampleRate: row.sampleRate,
    bitDepth: row.bitDepth,
    width: row.width,
    height: row.height,
  };
}

/** Requires `Database`, `Disk`, `MediaLibrary`, `MediaProcess`, and `Transcoding`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* Database.Service;
    const disk = yield* Disk.Service;
    const library = yield* MediaLibrary.Service;
    const transcoding = yield* Transcoding.Service;
    const media = yield* MediaProcess.Service;

    const plan = Effect.fn('Playback.plan')(function* (id: MediaEntryId, capabilities: PlaybackCapabilities) {
      const { entry } = yield* library.activeMedia(id);
      if (entry.probeStatus === 'failed')
        return { mode: 'unplayable', reason: 'Could not inspect this media file.' } as const;
      const [tracks, subtitles] = yield* orUnavailable(
        Effect.all(
          [
            db.select().from(mediaTracks).where(eq(mediaTracks.mediaEntryId, id)),
            db
              .select({
                id: externalSubtitles.id,
                name: externalSubtitles.name,
                format: externalSubtitles.format,
                language: externalSubtitles.language,
              })
              .from(externalSubtitles)
              .where(and(eq(externalSubtitles.mediaEntryId, id), isNull(externalSubtitles.deletedAt))),
          ],
          { concurrency: 2 },
        ),
      );
      const playable = {
        durationMs: entry.durationMs,
        audioTracks: tracks.filter((track) => track.kind === 'audio').map(toMediaTrack),
        subtitleTracks: [
          ...tracks.filter((track) => track.kind === 'subtitle').map(toMediaTrack),
          ...subtitles.map((subtitle): ExternalSubtitle => ({
            kind: 'external',
            id: subtitle.id as SubtitleId,
            name: subtitle.name,
            format: subtitle.format as ExternalSubtitle['format'],
            language: subtitle.language,
          })),
        ],
      };
      return canDirectPlay(entry, capabilities)
        ? ({ mode: 'direct', url: `/stream/${id}`, ...playable } as const)
        : ({ mode: 'hls', sessionUrl: `/api/playback/${id}/session`, ...playable } as const);
    });

    const startSession = Effect.fn('Playback.startSession')(function* (id: MediaEntryId, audioStream: number | null) {
      const source = yield* library.activeMedia(id);
      if (audioStream !== null) {
        const [track] = yield* orUnavailable(
          db
            .select({ id: mediaTracks.id })
            .from(mediaTracks)
            .where(
              and(
                eq(mediaTracks.mediaEntryId, id),
                eq(mediaTracks.streamIndex, audioStream),
                eq(mediaTracks.kind, 'audio'),
              ),
            )
            .limit(1),
        );
        if (!track) return yield* new AudioStreamNotFound({ mediaId: id, streamIndex: audioStream });
      }
      const durationMs = source.entry.durationMs;
      if (!durationMs || durationMs <= 0) return yield* new MediaDurationUnknown({ mediaId: id });
      return yield* transcoding.startSession({ id, path: source.path, durationMs }, audioStream);
    });

    const externalSubtitle = Effect.fn('Playback.externalSubtitle')(function* (id: SubtitleId) {
      const [row] = yield* orUnavailable(
        db
          .select({
            relativePath: externalSubtitles.relativePath,
            format: externalSubtitles.format,
            rootPath: mediaRoots.path,
          })
          .from(externalSubtitles)
          .innerJoin(mediaEntries, eq(externalSubtitles.mediaEntryId, mediaEntries.id))
          .innerJoin(mediaRoots, eq(mediaEntries.mediaRootId, mediaRoots.id))
          .where(and(eq(externalSubtitles.id, id), isNull(externalSubtitles.deletedAt)))
          .limit(1),
      );
      if (!row) return yield* new SubtitleNotFound({ id });
      const file = yield* library.fileInRoot(row.rootPath, row.relativePath);
      const text = yield* disk
        .readText(file)
        .pipe(
          Effect.catchTag('PathNotFound', () =>
            Effect.fail(new MediaFileUnavailable({ path: file, reason: 'missing' })),
          ),
        );
      return row.format === 'srt' ? srtToVtt(text) : text;
    });

    const extractions = yield* makeCapacity({
      concurrency: SUBTITLE_EXTRACTIONS,
      maxWaiting: 8,
      maxWait: '30 seconds',
    });

    /**
     * Converted embedded subtitles. Concurrent requests for one stream share a single FFmpeg run;
     * failures are not kept, so the next request tries again.
     */
    const converted = yield* Cache.makeWith(
      (key: SubtitleKey) => {
        // ASS keeps its typesetting as ASS, so Fern can drop what captions cannot show (see `assToVtt`).
        const ass = assCodecs.has(key.codec);
        const output = ass ? ['-c:s', 'copy', '-f', 'ass'] : ['-f', 'webvtt'];
        return extractions.withCapacity(
          media
            .run({
              program: 'ffmpeg',
              args: ['-v', 'error', '-i', key.file, '-map', `0:${key.stream}`, ...output, 'pipe:1'],
              timeout: subtitleExtractionTimeout(key.sizeBytes),
              maxStdoutBytes: 20_000_000,
            })
            .pipe(
              Effect.map((result) => (ass ? assToVtt(result.stdout.toString('utf8')) : result.stdout.toString('utf8'))),
              Effect.mapError((cause) => new SubtitleUnavailable({ cause })),
            ),
        );
      },
      {
        capacity: SUBTITLE_CACHE_ENTRIES,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? SUBTITLE_CACHE_TTL : 0),
      },
    );

    const embeddedSubtitle = Effect.fn('Playback.embeddedSubtitle')(function* (id: MediaEntryId, streamIndex: number) {
      const [track] = yield* orUnavailable(
        db
          .select({ codec: mediaTracks.codec })
          .from(mediaTracks)
          .where(
            and(
              eq(mediaTracks.mediaEntryId, id),
              eq(mediaTracks.streamIndex, streamIndex),
              eq(mediaTracks.kind, 'subtitle'),
            ),
          )
          .limit(1),
      );
      if (!track) return yield* new SubtitleNotFound({ id: `${id}:${streamIndex}` });
      if (!textSubtitleCodecs.has(track.codec)) return yield* new SubtitleRequiresBurnIn({ codec: track.codec });
      const source = yield* library.activeMedia(id);
      const version = yield* disk
        .stat(source.path)
        .pipe(
          Effect.catchTag('PathNotFound', () =>
            Effect.fail(new MediaFileUnavailable({ path: source.path, reason: 'missing' })),
          ),
        );
      return yield* Cache.get(converted, {
        file: source.path,
        version: `${version.size}:${version.mtimeMs}`,
        sizeBytes: version.size,
        stream: streamIndex,
        codec: track.codec,
      });
    });

    return Service.of({ plan, startSession, externalSubtitle, embeddedSubtitle });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(Transcoding.defaultLayer),
  Layer.provide(MediaLibrary.defaultLayer),
  Layer.provide(MediaProcess.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(Disk.layer),
);

export * as Playback from './service';
