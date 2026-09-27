import { and, eq, isNull } from 'drizzle-orm';
import { Cache, Context, Effect, Exit, Layer } from 'effect';
import { externalSubtitles, mediaEntries, mediaRoots, mediaTracks } from '$lib/server/db/schema';
import { Database, orUnavailable, type DatabaseUnavailable } from '$lib/server/db/service';
import { MediaFileUnavailable, type MediaFileError, type MediaNotFound } from '$lib/server/media/errors';
import { MediaLibrary } from '$lib/server/media/library';
import { canDirectPlay } from '$lib/server/media/playback-plan';
import { FileSystem } from '$lib/server/platform/filesystem';
import { MediaProcessRunner } from '$lib/server/media/process-runner';
import { makeCapacity, type CapacityExceeded } from '$lib/server/media/work';
import { Transcoding } from '$lib/server/transcoding/service';
import type { MediaEntryId, SubtitleId } from '$lib/shared/contracts/ids';
import type {
  ExternalSubtitle,
  HlsSession,
  MediaTrack,
  PlaybackCapabilities,
  PlaybackPlan,
} from '$lib/shared/contracts/playback';
import {
  AudioStreamNotFound,
  MediaDurationUnknown,
  SubtitleNotFound,
  SubtitleRequiresBurnIn,
  SubtitleUnavailable,
} from './errors';
import { assToVtt } from './ass';

/** Extractions that may run at once; each reads through the whole media file. */
const SUBTITLE_EXTRACTIONS = 2;
/** Converted subtitles kept in memory, so switching tracks or reloading the page does not extract again. */
const SUBTITLE_CACHE_ENTRIES = 16;
const SUBTITLE_CACHE_TTL = '30 minutes';

/** Embedded subtitle codecs FFmpeg can convert to WebVTT. */
const textSubtitleCodecs = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text']);
const assCodecs = new Set(['ass', 'ssa']);

function srtToVtt(srt: string) {
  return `WEBVTT\n\n${srt.replace(/^\uFEFF/, '').replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2')}`;
}

type MediaLookupError = MediaNotFound | MediaFileError | DatabaseUnavailable;

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

/** Playback decisions for the watch page: plans, HLS sessions, and subtitles. */
export class Playback extends Context.Service<Playback>()('fern/Playback', {
  make: Effect.gen(function* () {
    const db = yield* Database;
    const fs = yield* FileSystem;
    const library = yield* MediaLibrary;
    const transcoding = yield* Transcoding;
    const runner = yield* MediaProcessRunner;

    const plan = (
      id: MediaEntryId,
      capabilities: PlaybackCapabilities,
    ): Effect.Effect<PlaybackPlan, MediaLookupError> =>
      Effect.gen(function* () {
        const { entry } = yield* library.activeMedia(id);
        if (entry.probeStatus === 'failed') return { mode: 'unplayable', reason: 'Could not inspect this media file.' };
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
          audioTracks: tracks.filter((track) => track.kind === 'audio').map((track) => toMediaTrack(track)),
          subtitleTracks: [
            ...tracks.filter((track) => track.kind === 'subtitle').map((track) => toMediaTrack(track)),
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
          ? { mode: 'direct', url: `/stream/${id}`, ...playable }
          : { mode: 'hls', sessionUrl: `/api/playback/${id}/session`, ...playable };
      });

    const startSession = (
      id: MediaEntryId,
      audioStream: number | null,
    ): Effect.Effect<HlsSession, MediaLookupError | AudioStreamNotFound | MediaDurationUnknown> =>
      Effect.gen(function* () {
        const media = yield* library.activeMedia(id);
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
        const durationMs = media.entry.durationMs;
        if (!durationMs || durationMs <= 0) return yield* new MediaDurationUnknown({ mediaId: id });
        return yield* transcoding.startSession({ id, path: media.path, durationMs }, audioStream);
      });

    /** A subtitle file next to the video, as WebVTT. */
    const externalSubtitle = (
      id: SubtitleId,
    ): Effect.Effect<string, SubtitleNotFound | MediaFileError | DatabaseUnavailable> =>
      Effect.gen(function* () {
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
        const text = yield* fs
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
     * Converted embedded subtitles, keyed by file, file version, and stream (as JSON). Concurrent
     * requests for one stream share a single FFmpeg run; failures are not kept, so the next request
     * tries again.
     */
    const converted = yield* Cache.makeWith(
      (key: string) => {
        const { file, stream, codec } = JSON.parse(key) as { file: string; stream: number; codec: string };
        // ASS keeps its typesetting as ASS, so Fern can drop what captions cannot show (see `assToVtt`).
        const ass = assCodecs.has(codec);
        const output = ass ? ['-c:s', 'copy', '-f', 'ass'] : ['-f', 'webvtt'];
        return extractions.withCapacity(
          runner
            .run({
              program: 'ffmpeg',
              args: ['-v', 'error', '-i', file, '-map', `0:${stream}`, ...output, 'pipe:1'],
              timeout: '60 seconds',
              maxStdoutBytes: 20_000_000,
            })
            .pipe(
              Effect.map(({ stdout }) => (ass ? assToVtt(stdout.toString('utf8')) : stdout.toString('utf8'))),
              Effect.mapError((cause) => new SubtitleUnavailable({ cause })),
            ),
        );
      },
      {
        capacity: SUBTITLE_CACHE_ENTRIES,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? SUBTITLE_CACHE_TTL : 0),
      },
    );

    /** An embedded text subtitle converted to WebVTT, at most a few at a time. */
    const embeddedSubtitle = (
      id: MediaEntryId,
      streamIndex: number,
    ): Effect.Effect<
      string,
      MediaLookupError | SubtitleNotFound | SubtitleRequiresBurnIn | SubtitleUnavailable | CapacityExceeded
    > =>
      Effect.gen(function* () {
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
        const media = yield* library.activeMedia(id);
        const version = yield* fs
          .stat(media.path)
          .pipe(
            Effect.catchTag('PathNotFound', () =>
              Effect.fail(new MediaFileUnavailable({ path: media.path, reason: 'missing' })),
            ),
          );
        const key = JSON.stringify({
          file: media.path,
          version: `${version.size}:${version.mtimeMs}`,
          stream: streamIndex,
          codec: track.codec,
        });
        return yield* Cache.get(converted, key);
      }).pipe(Effect.withSpan('playback.subtitle.extract'));

    return { plan, startSession, externalSubtitle, embeddedSubtitle } as const;
  }),
}) {
  /** Requires `Database`, `FileSystem`, `MediaLibrary`, `MediaProcessRunner`, and `Transcoding`. */
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  /** Requires `Database` and `FernConfig`. */
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(Transcoding.layer),
    Layer.provide(MediaLibrary.layer),
    Layer.provide(MediaProcessRunner.layer),
    Layer.provide(FileSystem.layer),
  );
}
