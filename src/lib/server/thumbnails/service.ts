import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Clock, Context, DateTime, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { FernConfig } from '$lib/server/config';
import type { DatabaseUnavailable } from '$lib/server/db/service';
import { selectEvictions } from '$lib/server/media/cache-policy';
import { MediaFileUnavailable, type MediaFileError, type MediaNotFound } from '$lib/server/media/errors';
import { MediaLibrary } from '$lib/server/media/library';
import { MediaProcess, ProcessError } from '$lib/server/media/process';
import { makeCapacity, makeSharedWork, makeThrottled, type CapacityExceeded } from '$lib/server/media/work';
import { Disk } from '$lib/server/platform/disk';
import type { MediaEntryId } from '$lib/shared/contracts/ids';

/** FFmpeg could not extract a frame, for example from a file without video. */
export class ThumbnailFailed extends Schema.TaggedError<ThumbnailFailed>()('ThumbnailFailed', {
  cause: ProcessError,
}) {}

/** A JPEG thumbnail and the cache key that names it, for ETags. */
export type Thumbnail = { readonly contents: Uint8Array; readonly key: string };

/** Progress-bar and card thumbnails: one JPEG frame per media file and position, cached on disk. */
export interface Interface {
  /** The JPEG for a position, clamped to the media, generated on first request. */
  readonly thumbnailAt: (
    id: MediaEntryId,
    positionMs: number,
  ) => Effect.Effect<
    Thumbnail,
    ThumbnailFailed | CapacityExceeded | MediaNotFound | MediaFileError | DatabaseUnavailable
  >;
}

export class Service extends Context.Service<Service, Interface>()('@fern/Thumbnails') {}

const CACHE_VERSION = 'v1';
const thumbnailPattern = /^[a-f0-9]{64}\.jpg$/;

/** Requires `FernConfig`, `MediaProcess`, `MediaLibrary`, `Disk`, and `FileSystem`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* FernConfig.Service;
    const media = yield* MediaProcess.Service;
    const library = yield* MediaLibrary.Service;
    const disk = yield* Disk.Service;
    const fs = yield* FileSystem.FileSystem;
    const directory = config.THUMBNAIL_CACHE_DIR;
    const shared = yield* makeSharedWork<ThumbnailFailed | CapacityExceeded>();
    const capacity = yield* makeCapacity({ concurrency: 2, maxWaiting: 16, maxWait: '15 seconds' });

    const removeQuietly = (file: string) => fs.remove(file, { force: true }).pipe(Effect.ignore);

    /** Evicts old thumbnails, at most once a minute because it lists the whole cache directory. */
    const sweepCache = yield* makeThrottled(
      Effect.gen(function* () {
        const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed((): string[] => []));
        const items = yield* Effect.forEach(
          names.filter((name) => thumbnailPattern.test(name)),
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
            maxAgeMs: config.THUMBNAIL_CACHE_MAX_AGE_HOURS * 3_600_000,
            maxBytes: config.THUMBNAIL_CACHE_MAX_BYTES,
            protectedKeys: new Set(shared.inFlightKeys().map((file) => path.basename(file))),
          },
        );
        yield* Effect.forEach(evictions, (name) => removeQuietly(path.join(directory, name)), { discard: true });
      }),
      '1 minute',
    );

    const generate = Effect.fn('Thumbnails.generate')(function* (input: string, output: string, positionMs: number) {
      const temporary = `${output}.${randomUUID()}.tmp.jpg`;
      yield* Effect.gen(function* () {
        // Failures of the cache directory itself are defects.
        yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie);
        yield* media
          .run({
            program: 'ffmpeg',
            args: [
              ...['-y', '-v', 'error', '-ss', (positionMs / 1000).toFixed(3), '-i', input],
              ...['-map', '0:v:0', '-frames:v', '1', '-an'],
              ...['-vf', 'scale=640:-2:force_original_aspect_ratio=decrease', '-q:v', '3', temporary],
            ],
            timeout: '30 seconds',
          })
          .pipe(Effect.mapError((cause) => new ThumbnailFailed({ cause })));
        yield* fs.rename(temporary, output).pipe(Effect.orDie);
        yield* sweepCache;
      }).pipe(Effect.ensuring(removeQuietly(temporary)));
    });

    const thumbnailAt = Effect.fn('Thumbnails.thumbnailAt')(
      function* (id: MediaEntryId, requestedPositionMs: number) {
        const source = yield* library.activeMedia(id);
        const version = yield* disk
          .stat(source.path)
          .pipe(
            Effect.catchTag('PathNotFound', () =>
              Effect.fail(new MediaFileUnavailable({ path: source.path, reason: 'missing' })),
            ),
          );
        const end = source.entry.durationMs ? Math.max(0, source.entry.durationMs - 1000) : requestedPositionMs;
        const positionMs = Math.min(Math.max(0, Math.round(requestedPositionMs)), end);
        const key = createHash('sha256')
          .update(`${id}:${version.size}:${version.mtimeMs}:${positionMs}:${CACHE_VERSION}`)
          .digest('hex');
        const file = path.join(directory, `${key}.jpg`);
        const read = fs.readFile(file).pipe(Effect.option);

        const cached = yield* read;
        if (Option.isSome(cached)) {
          // Marks the thumbnail as recently used, so eviction keeps it.
          const now = yield* DateTime.nowAsDate;
          yield* fs.utimes(file, now, now).pipe(Effect.ignore);
          return { contents: cached.value, key };
        }
        yield* shared
          .run(file, capacity.withCapacity(generate(source.path, file, positionMs)))
          .pipe(Effect.annotateLogs({ cacheKey: key }));
        const generated = yield* read;
        if (Option.isNone(generated)) return yield* Effect.die(new Error('Generated thumbnail is missing'));
        return { contents: generated.value, key };
      },
      (effect, id) => Effect.annotateLogs(effect, { mediaId: id }),
    );

    return Service.of({ thumbnailAt });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(MediaLibrary.defaultLayer),
  Layer.provide(MediaProcess.defaultLayer),
  Layer.provide(Disk.layer),
  Layer.provide(NodeServices.layer),
  Layer.provide(FernConfig.defaultLayer),
);

export * as Thumbnails from './service';
