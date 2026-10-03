import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Clock, Context, DateTime, Duration, Effect, FileSystem, Layer, Option, Schema, Stream } from 'effect';
import { FernConfig } from '$lib/server/config';
import type { DatabaseUnavailable } from '$lib/server/db/service';
import { selectEvictions } from '$lib/server/media/cache-policy';
import { MediaFileUnavailable, type MediaFileError, type MediaNotFound } from '$lib/server/media/errors';
import { MediaLibrary } from '$lib/server/media/library';
import { MediaProcess, ProcessError } from '$lib/server/media/process';
import { makeCapacity, makeSharedWork, makeThrottled, type CapacityExceeded } from '$lib/server/media/work';
import { Disk } from '$lib/server/platform/disk';
import type { MediaEntryId } from '$lib/shared/contracts/ids';
import { encodeTrackMap } from '$lib/shared/contracts/track-map';
import { ANALYSIS_VERSION, loudnessMeter, mapTrack, SAMPLE_RATE } from './analysis';

/** FFmpeg could not decode the track's audio, for example from a file without any. */
export class TrackMapFailed extends Schema.TaggedError<TrackMapFailed>()('TrackMapFailed', {
  cause: ProcessError,
}) {}

/** A track map as the JSON the FX page fetches, and the cache key that names it, for ETags. */
export type CachedTrackMap = { readonly contents: Uint8Array; readonly key: string };

/**
 * Track maps for the music visual effects (see `analysis.ts`): each track's audio decoded by FFmpeg
 * and analysed as it streams in, once per file, cached on disk as the JSON the FX page fetches.
 */
export interface Interface {
  /** The track's map as JSON, analysed on first request. */
  readonly trackMapOf: (
    id: MediaEntryId,
  ) => Effect.Effect<
    CachedTrackMap,
    TrackMapFailed | CapacityExceeded | MediaNotFound | MediaFileError | DatabaseUnavailable
  >;
}

export class Service extends Context.Service<Service, Interface>()('@fern/TrackMaps') {}

const trackMapPattern = /^[a-f0-9]{64}\.json$/;

/**
 * How long reading a track may take: a few minutes, and a tenth of the track's length on top for
 * hours-long mixes. Decoding and measuring run hundreds of times faster than the music plays (a
 * two-hour mix takes seconds), so this only stops a reading that is stuck.
 */
const readingTimeout = (durationMs: number | null) => Duration.millis(3 * 60_000 + (durationMs ?? 0) / 10);

type Track = { readonly path: string; readonly durationMs: number | null; readonly chapterStarts: number[] };

/** Requires `FernConfig`, `MediaProcess`, `MediaLibrary`, `Disk`, and `FileSystem`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* FernConfig.Service;
    const media = yield* MediaProcess.Service;
    const library = yield* MediaLibrary.Service;
    const disk = yield* Disk.Service;
    const fs = yield* FileSystem.FileSystem;
    const directory = config.TRACK_MAP_CACHE_DIR;
    const shared = yield* makeSharedWork<TrackMapFailed | CapacityExceeded>();
    const capacity = yield* makeCapacity({ concurrency: 2, maxWaiting: 16, maxWait: '30 seconds' });

    const removeQuietly = (file: string) => fs.remove(file, { force: true }).pipe(Effect.ignore);

    /** Evicts old track maps, at most once a minute because it lists the whole cache directory. */
    const sweepCache = yield* makeThrottled(
      Effect.gen(function* () {
        const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed((): string[] => []));
        const items = yield* Effect.forEach(
          names.filter((name) => trackMapPattern.test(name)),
          (name) =>
            fs.stat(path.join(directory, name)).pipe(
              Effect.map((info) => ({
                key: name,
                bytes: Number(info.size),
                lastUsedMs: Option.match(info.mtime, { onNone: () => 0, onSome: (mtime) => mtime.getTime() }),
              })),
              Effect.option,
            ),
          { concurrency: 8 },
        );
        const evictions = selectEvictions(
          items.flatMap((item) => (Option.isSome(item) ? [item.value] : [])),
          {
            now: yield* Clock.currentTimeMillis,
            maxAgeMs: config.TRACK_MAP_CACHE_MAX_AGE_HOURS * 3_600_000,
            maxBytes: config.TRACK_MAP_CACHE_MAX_BYTES,
            protectedKeys: new Set(shared.inFlightKeys().map((file) => path.basename(file))),
          },
        );
        yield* Effect.forEach(evictions, (name) => removeQuietly(path.join(directory, name)), { discard: true });
      }),
      '1 minute',
    );

    const generate = Effect.fn('TrackMaps.generate')(function* (track: Track, output: string) {
      const temporary = `${output}.${randomUUID()}.tmp.json`;
      yield* Effect.gen(function* () {
        // Failures of the cache directory itself are defects.
        yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
        const meter = loudnessMeter(SAMPLE_RATE);
        // Hours of audio are hundreds of megabytes: it is measured as it arrives instead of collected.
        yield* media
          .stdout({
            program: 'ffmpeg',
            args: [
              ...['-v', 'error', '-i', track.path, '-map', '0:a:0', '-vn'],
              ...['-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'],
            ],
            timeout: readingTimeout(track.durationMs),
          })
          .pipe(
            Stream.runForEach((chunk) => Effect.sync(() => meter.write(chunk))),
            Effect.mapError((cause) => new TrackMapFailed({ cause })),
          );
        const map = mapTrack(meter.finish(), track.chapterStarts);
        yield* fs.writeFileString(temporary, JSON.stringify(encodeTrackMap(map))).pipe(Effect.orDie);
        yield* fs.rename(temporary, output).pipe(Effect.orDie);
        yield* sweepCache;
      }).pipe(Effect.ensuring(removeQuietly(temporary)));
    });

    const trackMapOf = Effect.fn('TrackMaps.trackMapOf')(
      function* (id: MediaEntryId) {
        const source = yield* library.activeMedia(id);
        const version = yield* disk
          .stat(source.path)
          .pipe(
            Effect.catchTag('PathNotFound', () =>
              Effect.fail(new MediaFileUnavailable({ path: source.path, reason: 'missing' })),
            ),
          );
        // Chapters are read from the file, but only once it is scanned again (after a scanner
        // update, say), so the map is made again when they change.
        const chapterStarts = yield* library.chapterStarts(id);
        const key = createHash('sha256')
          .update(`${id}:${version.size}:${version.mtimeMs}:${ANALYSIS_VERSION}:${chapterStarts.join(',')}`)
          .digest('hex');
        const file = path.join(directory, `${key}.json`);
        const read = fs.readFile(file).pipe(Effect.option);

        const cached = yield* read;
        if (Option.isSome(cached)) {
          // Marks the map as recently used, so eviction keeps it.
          const now = yield* DateTime.nowAsDate;
          yield* fs.utimes(file, now, now).pipe(Effect.ignore);
          return { contents: cached.value, key };
        }
        yield* shared
          .run(
            file,
            capacity.withCapacity(
              generate({ path: source.path, durationMs: source.entry.durationMs, chapterStarts }, file),
            ),
          )
          .pipe(Effect.annotateLogs({ cacheKey: key }));
        const generated = yield* read;
        if (Option.isNone(generated)) return yield* Effect.die(new Error('Generated track map is missing'));
        return { contents: generated.value, key };
      },
      (effect, id) => Effect.annotateLogs(effect, { mediaId: id }),
    );

    return Service.of({ trackMapOf });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(MediaLibrary.defaultLayer),
  Layer.provide(MediaProcess.defaultLayer),
  Layer.provide(Disk.layer),
  Layer.provide(NodeServices.layer),
  Layer.provide(FernConfig.defaultLayer),
);

export * as TrackMaps from './service';
