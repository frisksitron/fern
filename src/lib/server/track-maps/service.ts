import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Clock, Context, Data, Duration, Effect, Layer } from 'effect';
import { FernConfig } from '$lib/server/config';
import { selectEvictions } from '$lib/server/media/cache-policy';
import { MediaFileUnavailable } from '$lib/server/media/errors';
import { MediaLibrary } from '$lib/server/media/library';
import { MediaProcessRunner, type ProcessError } from '$lib/server/media/process-runner';
import { makeCapacity, makeSharedWork, makeThrottled, type CapacityExceeded } from '$lib/server/media/work';
import type { MediaEntryId } from '$lib/shared/contracts/ids';
import { encodeTrackMap } from '$lib/shared/contracts/track-map';
import { ANALYSIS_VERSION, loudnessMeter, mapSong, SAMPLE_RATE } from './analysis';

/** FFmpeg could not decode the track's audio, for example from a file without any. */
export class TrackMapFailed extends Data.TaggedError('TrackMapFailed')<{ readonly cause: ProcessError }> {}

const trackMapPattern = /^[a-f0-9]{64}\.json$/;

/**
 * How long reading a track may take: a few minutes, and a tenth of the track's length on top for
 * hours-long mixes. Decoding and measuring run hundreds of times faster than the music plays (a
 * two-hour mix takes seconds), so this only stops a reading that is stuck.
 */
const readingTimeout = (durationMs: number | null) => Duration.millis(3 * 60_000 + (durationMs ?? 0) / 10);

const io = <A>(run: () => Promise<A>) => Effect.orDie(Effect.tryPromise({ try: run, catch: (cause) => cause }));
const removeQuietly = (file: string) => Effect.promise(() => rm(file, { force: true }));

/**
 * Track maps for the music visual effects (see `analysis.ts`): each track's audio decoded by FFmpeg
 * and analysed as it streams in, once per file, cached on disk as the JSON the FX page fetches.
 */
export class TrackMaps extends Context.Service<TrackMaps>()('fern/TrackMaps', {
  make: Effect.gen(function* () {
    const config = yield* FernConfig;
    const runner = yield* MediaProcessRunner;
    const library = yield* MediaLibrary;
    const directory = config.TRACK_MAP_CACHE_DIR;
    const shared = yield* makeSharedWork<TrackMapFailed | CapacityExceeded>();
    const capacity = yield* makeCapacity({ concurrency: 2, maxWaiting: 16, maxWait: '30 seconds' });

    /** Evicts old track maps, at most once a minute because it lists the whole cache directory. */
    const sweepCache = yield* makeThrottled(
      Effect.gen(function* () {
        const names = yield* Effect.promise(() => readdir(directory).catch(() => [] as string[]));
        const items = yield* Effect.forEach(
          names.filter((name) => trackMapPattern.test(name)),
          (name) =>
            Effect.promise(() =>
              stat(path.join(directory, name)).then(
                (info) => ({ key: name, bytes: info.size, lastUsedMs: info.mtimeMs }),
                () => null,
              ),
            ),
          { concurrency: 8 },
        );
        const evictions = selectEvictions(
          items.filter((item) => item !== null),
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

    type Track = { readonly path: string; readonly durationMs: number | null };

    const generate = ({ path: input, durationMs }: Track, output: string) => {
      const temporary = `${output}.${randomUUID()}.tmp.json`;
      return Effect.gen(function* () {
        yield* io(() => mkdir(directory, { recursive: true }));
        const meter = loudnessMeter(SAMPLE_RATE);
        yield* runner
          .run({
            program: 'ffmpeg',
            args: [
              '-v',
              'error',
              '-i',
              input,
              '-map',
              '0:a:0',
              '-vn',
              '-ac',
              '1',
              '-ar',
              String(SAMPLE_RATE),
              '-f',
              'f32le',
              '-',
            ],
            timeout: readingTimeout(durationMs),
            // Hours of audio are hundreds of megabytes: it is measured as it arrives instead.
            onStdout: (chunk) => meter.write(chunk),
          })
          .pipe(Effect.mapError((cause) => new TrackMapFailed({ cause })));
        const map = mapSong(meter.finish());
        yield* io(() => writeFile(temporary, JSON.stringify(encodeTrackMap(map))));
        yield* io(() => rename(temporary, output));
        yield* sweepCache;
      }).pipe(Effect.ensuring(removeQuietly(temporary)), Effect.withSpan('trackMap.generate'));
    };

    /** The track's map as JSON, analysed on first request. */
    const trackMapOf = (id: MediaEntryId) =>
      Effect.gen(function* () {
        const media = yield* library.activeMedia(id);
        const info = yield* Effect.tryPromise({
          try: () => stat(media.path),
          catch: () => new MediaFileUnavailable({ path: media.path, reason: 'missing' }),
        });
        const key = createHash('sha256').update(`${id}:${info.size}:${info.mtimeMs}:${ANALYSIS_VERSION}`).digest('hex');
        const file = path.join(directory, `${key}.json`);
        const read = Effect.promise(() =>
          readFile(file).then(
            (contents) => contents,
            () => null,
          ),
        );
        const cached = yield* read;
        if (cached) {
          const now = new Date();
          yield* Effect.promise(() => utimes(file, now, now).catch(() => undefined));
          return { contents: cached, key };
        }
        yield* shared
          .run(file, capacity.withCapacity(generate({ path: media.path, durationMs: media.entry.durationMs }, file)))
          .pipe(Effect.annotateLogs({ cacheKey: key }));
        const contents = yield* read;
        if (!contents) return yield* Effect.die(new Error('Generated track map is missing'));
        return { contents, key };
      }).pipe(Effect.annotateLogs({ mediaId: id }));

    return { trackMapOf } as const;
  }),
}) {
  /** Requires `FernConfig`, `MediaProcessRunner`, and `MediaLibrary`. */
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  /** Requires `Database` and `FernConfig`. */
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(MediaLibrary.layer),
    Layer.provide(MediaProcessRunner.layer),
  );
}
