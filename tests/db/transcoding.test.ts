import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/lib/server/db/service';
import { MediaLibrary } from '../../src/lib/server/media/library';
import { MediaProcessRunner, ProcessExited, type ProcessRequest } from '../../src/lib/server/media/process-runner';
import { FileSystem } from '../../src/lib/server/platform/filesystem';
import { Thumbnails } from '../../src/lib/server/thumbnails/service';
import { Transcoding } from '../../src/lib/server/transcoding/service';
import { MediaEntryId } from '../../src/lib/shared/contracts/ids';
import { testConfig } from '../support/config';
import { createTestDatabase, type TestDatabase } from './support/database';

let database: TestDatabase;
let workspace: string;
let cacheDirectory: string;
let mediaFile: string;
let mediaId: MediaEntryId;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await database.pool.query('truncate media_roots cascade');
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = await mkdtemp(path.join(tmpdir(), 'fern-hls-'));
  cacheDirectory = path.join(workspace, 'cache');
  const library = path.join(workspace, 'library');
  await mkdir(library);
  mediaFile = path.join(library, 'movie.mkv');
  await writeFile(mediaFile, 'matroska');
  const rootId = randomUUID();
  mediaId = MediaEntryId.make(randomUUID());
  await database.pool.query(
    `insert into media_roots (id, path, display_name, media_type) values ($1, $2, 'Library', 'video')`,
    [rootId, library],
  );
  await database.pool.query(
    `insert into media_entries (id, media_root_id, relative_path, name, kind, mtime_ms, is_video, duration_ms, probe_status)
     values ($1, $2, 'movie.mkv', 'movie.mkv', 'file', 0, true, 30000, 'ok')`,
    [mediaId, rootId],
  );
});

type FakeOptions = {
  /** Encoders that pass hardware detection but fail on real segments. */
  readonly failEncoders?: readonly string[];
  /** Encoders that hardware detection reports as missing. */
  readonly missingEncoders?: readonly string[];
  readonly gate?: Deferred.Deferred<void>;
};

/** Stands in for FFmpeg: writes the requested output file, or fails for chosen encoders. */
function fakeFfmpeg(options: FakeOptions = {}) {
  const stats = { encodes: [] as string[], interrupted: 0 };
  const layer = Layer.succeed(MediaProcessRunner, {
    run: (request: ProcessRequest) =>
      Effect.gen(function* () {
        const args = request.args;
        // Thumbnail extraction names no encoder; call it `frame`.
        const encoder = args.includes('-c:v') ? args[args.indexOf('-c:v') + 1] : 'frame';
        const output = args.at(-1)!;
        const failed = new ProcessExited({ program: 'ffmpeg', code: 1, signal: null, stderr: `${encoder} failed` });
        if (output === '-') {
          if (options.missingEncoders?.includes(encoder)) return yield* failed;
        } else {
          stats.encodes.push(encoder);
          if (options.failEncoders?.includes(encoder)) return yield* failed;
          if (options.gate) yield* Deferred.await(options.gate);
          yield* Effect.promise(() => writeFile(output, `segment by ${encoder}`));
        }
        return { stdout: Buffer.alloc(0), stderr: '', durationMs: 1 };
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => stats.interrupted++))),
  });
  return { stats, layer };
}

function dependencies(runner: ReturnType<typeof fakeFfmpeg>, settings: Record<string, string>) {
  return Layer.mergeAll(
    testConfig({
      HLS_CACHE_DIR: cacheDirectory,
      THUMBNAIL_CACHE_DIR: path.join(workspace, 'thumbnails'),
      TRANSCODE_ACCELERATOR: 'software',
      ...settings,
    }),
    runner.layer,
    MediaLibrary.layerWithoutDependencies.pipe(Layer.provide(Layer.mergeAll(FileSystem.layer, database.layer))),
  );
}

function transcoding(runner: ReturnType<typeof fakeFfmpeg>, settings: Record<string, string> = {}) {
  const layer = Transcoding.layerWithoutDependencies.pipe(Layer.provide(dependencies(runner, settings)));
  return <A, E>(program: (service: Transcoding['Service']) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.scoped(Effect.provide(Transcoding.use(program), layer)));
}

const media = () => ({ id: mediaId, path: mediaFile, durationMs: 30_000 });
const temporaryFiles = async (session: string) =>
  (await readdir(path.join(cacheDirectory, session))).filter((name) => name.includes('.tmp.'));

describe('Transcoding', () => {
  it('prepares a stable session with the detected hardware encoder', async () => {
    const runner = fakeFfmpeg();
    const result = await transcoding(runner, { TRANSCODE_ACCELERATOR: 'auto' })((service) =>
      Effect.gen(function* () {
        const first = yield* service.startSession(media(), null);
        const second = yield* service.startSession(media(), null);
        const english = yield* service.startSession(media(), 2);
        return { first, second, english };
      }),
    );
    expect(result.first).toEqual(result.second);
    expect(result.english.sessionId).not.toBe(result.first.sessionId);
    const directory = path.join(cacheDirectory, result.first.sessionId);
    expect((await readdir(directory)).sort()).toEqual(['master.m3u8', 'session.json']);
    const metadata = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
    expect(metadata).toMatchObject({ accelerator: 'nvenc', audioStream: null, durationMs: 30_000 });
  });

  it('runs FFmpeg once for concurrent requests for the same segment', async () => {
    const runner = fakeFfmpeg();
    await transcoding(runner)((service) =>
      Effect.gen(function* () {
        const { sessionId } = yield* service.startSession(media(), null);
        const files = yield* Effect.forEach([1, 2, 3], () => service.hlsFile(sessionId, 'segment-00001.ts'), {
          concurrency: 'unbounded',
        });
        expect(new Set(files).size).toBe(1);
      }),
    );
    expect(runner.stats.encodes).toEqual(['libx264']);
  });

  it('stops FFmpeg and removes its temporary file when the request is abandoned', async () => {
    const gate = await Effect.runPromise(Deferred.make<void>());
    const runner = fakeFfmpeg({ gate });
    const session = await transcoding(runner)((service) =>
      Effect.gen(function* () {
        const { sessionId } = yield* service.startSession(media(), null);
        const request = yield* Effect.forkChild(service.hlsFile(sessionId, 'segment-00000.ts'));
        while (runner.stats.encodes.length === 0) yield* Effect.sleep('5 millis');
        yield* Fiber.interrupt(request);
        return sessionId;
      }),
    );
    expect(runner.stats.interrupted).toBe(1);
    expect(await readdir(path.join(cacheDirectory, session))).toEqual(['master.m3u8', 'session.json']);
  });

  it('answers with CapacityExceeded instead of queueing without bound', async () => {
    const gate = await Effect.runPromise(Deferred.make<void>());
    const runner = fakeFfmpeg({ gate });
    await transcoding(runner, { MAX_CONCURRENT_TRANSCODES: '1', TRANSCODE_MAX_WAITING: '1' })((service) =>
      Effect.gen(function* () {
        const { sessionId } = yield* service.startSession(media(), null);
        const running = yield* Effect.forkChild(service.hlsFile(sessionId, 'segment-00000.ts'));
        const waiting = yield* Effect.forkChild(service.hlsFile(sessionId, 'segment-00001.ts'));
        while (runner.stats.encodes.length === 0) yield* Effect.sleep('5 millis');
        yield* Effect.sleep('20 millis');
        expect(yield* Effect.flip(service.hlsFile(sessionId, 'segment-00002.ts'))).toMatchObject({
          _tag: 'CapacityExceeded',
        });
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(running);
        yield* Fiber.join(waiting);
      }),
    );
    expect(runner.stats.encodes).toHaveLength(2);
  });

  it('falls back to software when the hardware encoder fails, and keeps using software', async () => {
    const runner = fakeFfmpeg({ failEncoders: ['h264_nvenc'] });
    await transcoding(runner, { TRANSCODE_ACCELERATOR: 'nvenc' })((service) =>
      Effect.gen(function* () {
        const { sessionId } = yield* service.startSession(media(), null);
        yield* service.hlsFile(sessionId, 'segment-00000.ts');
        yield* service.hlsFile(sessionId, 'segment-00001.ts');
      }),
    );
    expect(runner.stats.encodes).toEqual(['h264_nvenc', 'libx264', 'libx264']);
  });

  it('uses software when detection finds no hardware encoder', async () => {
    const runner = fakeFfmpeg({ missingEncoders: ['h264_nvenc', 'h264_qsv'] });
    await transcoding(runner, { TRANSCODE_ACCELERATOR: 'auto' })((service) =>
      Effect.gen(function* () {
        const { sessionId } = yield* service.startSession(media(), null);
        yield* service.hlsFile(sessionId, 'segment-00000.ts');
      }),
    );
    expect(runner.stats.encodes).toEqual(['libx264']);
  });

  it('fails with TranscodeFailed, leaves no temporary file, and retries on the next request', async () => {
    const runner = fakeFfmpeg({ failEncoders: ['libx264'] });
    await transcoding(runner)((service) =>
      Effect.gen(function* () {
        const { sessionId } = yield* service.startSession(media(), null);
        expect(yield* Effect.flip(service.hlsFile(sessionId, 'segment-00000.ts'))).toMatchObject({
          _tag: 'TranscodeFailed',
        });
        expect(yield* Effect.promise(() => temporaryFiles(sessionId))).toEqual([]);
        yield* Effect.flip(service.hlsFile(sessionId, 'segment-00000.ts'));
      }),
    );
    expect(runner.stats.encodes).toEqual(['libx264', 'libx264']);
  });

  it('reports a source file that changed after the session started', async () => {
    const runner = fakeFfmpeg();
    await transcoding(runner)((service) =>
      Effect.gen(function* () {
        const { sessionId } = yield* service.startSession(media(), null);
        yield* Effect.promise(() => writeFile(mediaFile, 'a different, longer file'));
        expect(yield* Effect.flip(service.hlsFile(sessionId, 'segment-00000.ts'))).toMatchObject({
          _tag: 'MediaChanged',
        });
      }),
    );
  });

  it('rejects invalid names, out-of-range segments, and corrupt session metadata', async () => {
    const runner = fakeFfmpeg();
    await transcoding(runner)((service) =>
      Effect.gen(function* () {
        const { sessionId } = yield* service.startSession(media(), null);
        for (const [session, file] of [
          ['not-a-session', 'master.m3u8'],
          [sessionId, '../session.json'],
          [sessionId, 'segment-00099.ts'],
          ['a'.repeat(64), 'segment-00000.ts'],
        ])
          expect(yield* Effect.flip(service.hlsFile(session, file))).toMatchObject({ _tag: 'HlsFileNotFound' });
        yield* Effect.promise(() => writeFile(path.join(cacheDirectory, sessionId, 'session.json'), '{"mediaId":1}'));
        expect(yield* Effect.flip(service.hlsFile(sessionId, 'segment-00000.ts'))).toMatchObject({
          _tag: 'HlsFileNotFound',
        });
      }),
    );
  });

  it('evicts old sessions from the cache but never a session in use', async () => {
    const runner = fakeFfmpeg();
    const stale = path.join(cacheDirectory, 'b'.repeat(64));
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, 'segment-00000.ts'), 'old');
    const longAgo = new Date(Date.now() - 48 * 3_600_000);
    await utimes(stale, longAgo, longAgo);

    await transcoding(runner, { HLS_CACHE_MAX_AGE_HOURS: '24' })((service) =>
      Effect.gen(function* () {
        const { sessionId } = yield* service.startSession(media(), null);
        const active = path.join(cacheDirectory, sessionId);
        yield* Effect.promise(() => utimes(active, longAgo, longAgo));
        // Starting another session runs cleanup: the active session is protected despite its age.
        yield* service.startSession(media(), 1);
        for (let attempt = 0; attempt < 100; attempt++) {
          const staleExists = yield* Effect.promise(() =>
            stat(stale).then(
              () => true,
              () => false,
            ),
          );
          if (!staleExists) break;
          yield* Effect.sleep('10 millis');
        }
        expect(
          yield* Effect.promise(() =>
            stat(stale).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        expect(
          yield* Effect.promise(() =>
            stat(active).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(true);
      }),
    );
  });

  it('ends pending work when the service is released', async () => {
    const gate = await Effect.runPromise(Deferred.make<void>());
    const runner = fakeFfmpeg({ gate });
    const exit = await transcoding(runner)((service) =>
      Effect.gen(function* () {
        const { sessionId } = yield* service.startSession(media(), null);
        const request = yield* Effect.forkDetach(service.hlsFile(sessionId, 'segment-00000.ts'));
        while (runner.stats.encodes.length === 0) yield* Effect.sleep('5 millis');
        return request;
      }),
    ).then((request) => Effect.runPromise(Fiber.await(request)));
    expect(runner.stats.interrupted).toBe(1);
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe('Thumbnails', () => {
  function thumbnails(runner: ReturnType<typeof fakeFfmpeg>) {
    const layer = Thumbnails.layerWithoutDependencies.pipe(Layer.provide(dependencies(runner, {})));
    return <A, E>(program: (service: Thumbnails['Service']) => Effect.Effect<A, E>) =>
      Effect.runPromise(Effect.scoped(Effect.provide(Thumbnails.use(program), layer)));
  }
  const seekOf = (args: readonly string[]) => args[args.indexOf('-ss') + 1];

  it('extracts each frame once, clamps the position to the media, and serves later requests from disk', async () => {
    const seeks: string[] = [];
    const runner = fakeFfmpeg();
    const recording = {
      ...runner,
      layer: Layer.succeed(MediaProcessRunner, {
        run: (request: ProcessRequest) => {
          seeks.push(seekOf(request.args));
          return MediaProcessRunner.use((fake) => fake.run(request)).pipe(Effect.provide(runner.layer));
        },
      }),
    };
    const [first, again, clamped] = await thumbnails(recording)((service) =>
      Effect.gen(function* () {
        const concurrent = yield* Effect.forEach([1, 2], () => service.thumbnailAt(mediaId, 5_000), {
          concurrency: 'unbounded',
        });
        expect(concurrent[0].key).toBe(concurrent[1].key);
        return [concurrent[0], yield* service.thumbnailAt(mediaId, 5_000), yield* service.thumbnailAt(mediaId, 90_000)];
      }),
    );
    expect(first.contents.toString()).toBe('segment by frame');
    expect(again.key).toBe(first.key);
    expect(clamped.key).not.toBe(first.key);
    expect(seeks).toEqual(['5.000', '29.000']);
    expect((await readdir(path.join(workspace, 'thumbnails'))).filter((name) => name.includes('.tmp.'))).toEqual([]);
  });

  it('reports a frame FFmpeg cannot extract as ThumbnailFailed', async () => {
    const runner = fakeFfmpeg({ failEncoders: ['frame'] });
    await thumbnails(runner)((service) =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(service.thumbnailAt(mediaId, 0))).toMatchObject({ _tag: 'ThumbnailFailed' });
      }),
    );
  });
});
