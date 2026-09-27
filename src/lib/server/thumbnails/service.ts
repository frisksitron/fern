import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { Clock, Context, Data, Effect, Layer } from 'effect';
import { FernConfig } from '$lib/server/config';
import { selectEvictions } from '$lib/server/media/cache-policy';
import { MediaFileUnavailable } from '$lib/server/media/errors';
import { MediaLibrary } from '$lib/server/media/library';
import { MediaProcessRunner, type ProcessError } from '$lib/server/media/process-runner';
import { makeCapacity, makeSharedWork, makeThrottled, type CapacityExceeded } from '$lib/server/media/work';
import type { MediaEntryId } from '$lib/shared/contracts/ids';

/** FFmpeg could not extract a frame, for example from a file without video. */
export class ThumbnailFailed extends Data.TaggedError('ThumbnailFailed')<{ readonly cause: ProcessError }> {}

const CACHE_VERSION = 'v1';
const thumbnailPattern = /^[a-f0-9]{64}\.jpg$/;

const io = <A>(run: () => Promise<A>) => Effect.orDie(Effect.tryPromise({ try: run, catch: (cause) => cause }));
const removeQuietly = (file: string) => Effect.promise(() => rm(file, { force: true }));

/** Progress-bar and card thumbnails: one JPEG frame per media file and position, cached on disk. */
export class Thumbnails extends Context.Service<Thumbnails>()('fern/Thumbnails', {
  make: Effect.gen(function* () {
    const config = yield* FernConfig;
    const runner = yield* MediaProcessRunner;
    const library = yield* MediaLibrary;
    const directory = config.THUMBNAIL_CACHE_DIR;
    const shared = yield* makeSharedWork<ThumbnailFailed | CapacityExceeded>();
    const capacity = yield* makeCapacity({ concurrency: 2, maxWaiting: 16, maxWait: '15 seconds' });

    /** Evicts old thumbnails, at most once a minute because it lists the whole cache directory. */
    const sweepCache = yield* makeThrottled(
      Effect.gen(function* () {
        const names = yield* Effect.promise(() => readdir(directory).catch(() => [] as string[]));
        const items = yield* Effect.forEach(
          names.filter((name) => thumbnailPattern.test(name)),
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
            maxAgeMs: config.THUMBNAIL_CACHE_MAX_AGE_HOURS * 3_600_000,
            maxBytes: config.THUMBNAIL_CACHE_MAX_BYTES,
            protectedKeys: new Set(shared.inFlightKeys().map((file) => path.basename(file))),
          },
        );
        yield* Effect.forEach(evictions, (name) => removeQuietly(path.join(directory, name)), { discard: true });
      }),
      '1 minute',
    );

    const generate = (input: string, output: string, positionMs: number) => {
      const temporary = `${output}.${randomUUID()}.tmp.jpg`;
      return Effect.gen(function* () {
        yield* io(() => mkdir(directory, { recursive: true }));
        yield* runner
          .run({
            program: 'ffmpeg',
            args: [
              '-y',
              '-v',
              'error',
              '-ss',
              (positionMs / 1000).toFixed(3),
              '-i',
              input,
              '-map',
              '0:v:0',
              '-frames:v',
              '1',
              '-an',
              '-vf',
              'scale=640:-2:force_original_aspect_ratio=decrease',
              '-q:v',
              '3',
              temporary,
            ],
            timeout: '30 seconds',
          })
          .pipe(Effect.mapError((cause) => new ThumbnailFailed({ cause })));
        yield* io(() => rename(temporary, output));
        yield* sweepCache;
      }).pipe(Effect.ensuring(removeQuietly(temporary)), Effect.withSpan('thumbnail.generate'));
    };

    /** The JPEG for a position, clamped to the media, generated on first request. */
    const thumbnailAt = (id: MediaEntryId, requestedPositionMs: number) =>
      Effect.gen(function* () {
        const media = yield* library.activeMedia(id);
        const info = yield* Effect.tryPromise({
          try: () => stat(media.path),
          catch: () => new MediaFileUnavailable({ path: media.path, reason: 'missing' }),
        });
        const end = media.entry.durationMs ? Math.max(0, media.entry.durationMs - 1000) : requestedPositionMs;
        const positionMs = Math.min(Math.max(0, Math.round(requestedPositionMs)), end);
        const key = createHash('sha256')
          .update(`${id}:${info.size}:${info.mtimeMs}:${positionMs}:${CACHE_VERSION}`)
          .digest('hex');
        const file = path.join(directory, `${key}.jpg`);
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
          .run(file, capacity.withCapacity(generate(media.path, file, positionMs)))
          .pipe(Effect.annotateLogs({ cacheKey: key }));
        const contents = yield* read;
        if (!contents) return yield* Effect.die(new Error('Generated thumbnail is missing'));
        return { contents, key };
      }).pipe(Effect.annotateLogs({ mediaId: id }));

    return { thumbnailAt } as const;
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
