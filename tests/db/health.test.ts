import { NodeServices } from '@effect/platform-node';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
import { MediaProcess, ProcessSpawnFailed } from '../../src/lib/server/media/process';
import { Health } from '../../src/lib/server/operations/health';
import { testConfig } from '../support/config';
import { TestDatabase } from './support/database';

const allOk = {
  database: 'ok',
  ffmpeg: 'ok',
  ffprobe: 'ok',
  hlsCache: 'ok',
  thumbnailCache: 'ok',
  trackMapCache: 'ok',
  downloads: 'ok',
} as const;

/**
 * Health on the test database, with a fake process runner where `missing` programs are not installed
 * and the cache and downloads folders in a temporary directory. `absent` folders don't exist yet;
 * `blocked` ones can't be created, because their parent is a file.
 */
function health(
  options: { missing?: readonly string[]; absent?: readonly string[]; blocked?: readonly string[] } = {},
) {
  const { missing = [], absent = [], blocked = [] } = options;
  const media = Layer.mock(MediaProcess.Service, {
    run: (request) =>
      missing.includes(request.program)
        ? Effect.fail(new ProcessSpawnFailed({ program: request.program, cause: new Error('ENOENT') }))
        : Effect.succeed({ stdout: Buffer.alloc(0), stderr: '', durationMs: 1 }),
  });
  const config = Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'fern-health-' });
      yield* fs.writeFileString(`${root}/file`, '');
      const folder = (name: string, directory: string) =>
        blocked.includes(name) ? `${root}/file/${directory}` : `${root}/${directory}`;
      const folders = {
        HLS_CACHE_DIR: folder('HLS_CACHE_DIR', 'hls'),
        THUMBNAIL_CACHE_DIR: folder('THUMBNAIL_CACHE_DIR', 'thumbnails'),
        TRACK_MAP_CACHE_DIR: folder('TRACK_MAP_CACHE_DIR', 'track-maps'),
        DOWNLOADS_DIR: folder('DOWNLOADS_DIR', 'downloads'),
      };
      for (const [name, directory] of Object.entries(folders)) {
        if (!absent.includes(name) && !blocked.includes(name)) yield* fs.makeDirectory(directory);
      }
      return testConfig(folders);
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  // Fresh: each test gets its own Health with its own fakes, not the block's memoized one.
  return Effect.provide(
    Layer.fresh(Health.layer).pipe(Layer.provide(Layer.mergeAll(media, config, NodeServices.layer))),
  );
}

layer(TestDatabase.layer, { excludeTestServices: true })('Health', (it) => {
  it.effect('is ready when the database answers, FFmpeg and ffprobe run, and the folders are writable', () =>
    Effect.gen(function* () {
      const service = yield* Health.Service;
      expect(yield* service.readiness()).toEqual({ status: 'ready', checks: allOk });
    }).pipe(health()),
  );

  it.effect('is not ready when a media executable is missing', () =>
    Effect.gen(function* () {
      const service = yield* Health.Service;
      expect(yield* service.readiness()).toEqual({
        status: 'unavailable',
        checks: { ...allOk, ffprobe: 'unavailable' },
      });
    }).pipe(health({ missing: ['ffprobe'] })),
  );

  it.effect('creates a missing cache or downloads folder, as the services do on first use', () =>
    Effect.gen(function* () {
      const service = yield* Health.Service;
      expect(yield* service.readiness()).toEqual({ status: 'ready', checks: allOk });
    }).pipe(health({ absent: ['HLS_CACHE_DIR', 'TRACK_MAP_CACHE_DIR'] })),
  );

  it.effect('is not ready when a cache or downloads folder cannot be written', () =>
    Effect.gen(function* () {
      const service = yield* Health.Service;
      expect(yield* service.readiness()).toEqual({
        status: 'unavailable',
        checks: { ...allOk, hlsCache: 'unavailable', downloads: 'unavailable' },
      });
    }).pipe(health({ blocked: ['HLS_CACHE_DIR', 'DOWNLOADS_DIR'] })),
  );
});
