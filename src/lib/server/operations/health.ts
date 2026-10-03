import { NodeServices } from '@effect/platform-node';
import { sql } from 'drizzle-orm';
import { Context, Duration, Effect, Exit, FileSystem, Layer, Option } from 'effect';
import { FernConfig } from '$lib/server/config';
import { Database, orUnavailable } from '$lib/server/db/service';
import { MediaProcess, type MediaProgram } from '$lib/server/media/process';
import type { ReadinessResponse } from '$lib/shared/contracts/health';

type CheckStatus = ReadinessResponse['checks']['database'];

/** Readiness checks for operators. */
export interface Interface {
  /**
   * Whether this process can serve traffic: the database answers, FFmpeg and ffprobe run, and the
   * cache and downloads folders are writable.
   */
  readonly readiness: () => Effect.Effect<ReadinessResponse>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/Health') {}

/** Requires `Database`, `MediaProcess`, `FernConfig`, and `FileSystem`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* Database.Service;
    const media = yield* MediaProcess.Service;
    const config = yield* FernConfig.Service;
    const fs = yield* FileSystem.FileSystem;

    const executable = (program: MediaProgram) =>
      check(media.run({ program, args: ['-version'], timeout: '5 seconds' }), '6 seconds');
    // Probes run often and starting processes is not free, so executables are checked once a minute.
    const executables = yield* Effect.cachedWithTTL(
      Effect.all({ ffmpeg: executable('ffmpeg'), ffprobe: executable('ffprobe') }, { concurrency: 2 }),
      '1 minute',
    );
    // A volume mounted with the wrong owner leaves these unwritable while everything else works.
    const writable = (directory: string) => check(fs.access(directory, { writable: true }), '2 seconds');

    const readiness = Effect.fn('Health.readiness')(function* () {
      const [database, programs, folders] = yield* Effect.all(
        [
          check(orUnavailable(db.execute(sql`select 1`)), '2 seconds'),
          executables,
          Effect.all(
            {
              hlsCache: writable(config.HLS_CACHE_DIR),
              thumbnailCache: writable(config.THUMBNAIL_CACHE_DIR),
              trackMapCache: writable(config.TRACK_MAP_CACHE_DIR),
              downloads: writable(config.DOWNLOADS_DIR),
            },
            { concurrency: 'unbounded' },
          ),
        ],
        { concurrency: 'unbounded' },
      );
      const checks = { database, ...programs, ...folders };
      const ready = Object.values(checks).every((status) => status === 'ok');
      if (!ready) yield* Effect.logWarning('Not ready').pipe(Effect.annotateLogs(checks));
      return { status: ready ? ('ready' as const) : ('unavailable' as const), checks };
    });

    return Service.of({ readiness });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(MediaProcess.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(NodeServices.layer),
  Layer.provide(FernConfig.defaultLayer),
);

/** `ok` when `effect` succeeds within `timeout`; any failure, defect, or timeout is `unavailable`. */
function check(effect: Effect.Effect<unknown, unknown>, timeout: Duration.Input): Effect.Effect<CheckStatus> {
  return Effect.exit(Effect.timeoutOption(effect, timeout)).pipe(
    Effect.map((exit) => (Exit.isSuccess(exit) && Option.isSome(exit.value) ? 'ok' : 'unavailable')),
  );
}

export * as Health from './health';
