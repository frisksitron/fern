import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { expect, layer } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Schedule, Stream } from 'effect';
import { SqlClient } from 'effect/sql';
import { TestClock } from 'effect/testing';
import { MediaLibrary } from '../../src/lib/server/media/library';
import { MediaProcess, ProcessExited, ProcessTimedOut } from '../../src/lib/server/media/process';
import { SharedWorkGrace } from '../../src/lib/server/media/work';
import { Disk } from '../../src/lib/server/platform/disk';
import { Thumbnails } from '../../src/lib/server/thumbnails/service';
import { Transcoding } from '../../src/lib/server/transcoding/service';
import { MediaEntryId } from '../../src/lib/shared/contracts/ids';
import { testConfig } from '../support/config';
import { TestDatabase } from './support/database';

/** A library with one indexed 30-second video, and an empty cache, in a directory removed after the test. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  yield* TestDatabase.truncate('media_roots');
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: 'fern-hls-' });
  const library = path.join(workspace, 'library');
  yield* fs.makeDirectory(library);
  const mediaFile = path.join(library, 'movie.mkv');
  yield* fs.writeFileString(mediaFile, 'matroska');
  const rootId = randomUUID();
  const mediaId = MediaEntryId.make(randomUUID());
  yield* sql`insert into media_roots (id, path, display_name, media_type) values (${rootId}, ${library}, 'Library', 'video')`;
  yield* sql`insert into media_entries (id, media_root_id, relative_path, name, kind, mtime_ms, is_video, duration_ms, probe_status)
    values (${mediaId}, ${rootId}, 'movie.mkv', 'movie.mkv', 'file', 0, true, 30000, 'ok')`;
  return {
    workspace,
    cacheDirectory: path.join(workspace, 'cache'),
    mediaFile,
    mediaId,
    media: { id: mediaId, path: mediaFile, durationMs: 30_000 },
  };
});

type Fixture = Effect.Success<typeof fixture>;

type FakeOptions = {
  /** Encoders that pass hardware detection but fail on real segments. */
  readonly failEncoders?: readonly string[];
  /** Encoders that pass hardware detection but time out on real segments. */
  readonly timeoutEncoders?: readonly string[];
  /** Encoders that hardware detection reports as missing. */
  readonly missingEncoders?: readonly string[];
  /** Holds every encode until it is opened. */
  readonly gate?: Deferred.Deferred<void>;
};

/** Stands in for FFmpeg: writes the requested output file, or fails for chosen encoders. */
const fakeFfmpeg = Effect.fnUntraced(function* (options: FakeOptions = {}) {
  const stats = { encodes: [] as string[], runs: [] as (readonly string[])[], interrupted: 0 };
  /** Opens when the first encode (not a detection) starts. */
  const encoding = yield* Deferred.make<void>();
  const layer = Layer.effect(
    MediaProcess.Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return MediaProcess.Service.of({
        run: (request) =>
          Effect.gen(function* () {
            const args = request.args;
            // Thumbnail extraction names no encoder; call it `frame`.
            const encoder = args.includes('-c:v') ? args[args.indexOf('-c:v') + 1] : 'frame';
            const output = args.at(-1) ?? '';
            const failed = new ProcessExited({ program: 'ffmpeg', code: 1, stderr: `${encoder} failed` });
            stats.runs.push(args);
            if (output === '-') {
              if (options.missingEncoders?.includes(encoder)) return yield* failed;
            } else {
              stats.encodes.push(encoder);
              yield* Deferred.succeed(encoding, undefined);
              if (options.timeoutEncoders?.includes(encoder))
                return yield* new ProcessTimedOut({ program: 'ffmpeg', timeoutMs: 30_000 });
              if (options.failEncoders?.includes(encoder)) return yield* failed;
              if (options.gate) yield* Deferred.await(options.gate);
              yield* fs.writeFileString(output, `segment by ${encoder}`).pipe(Effect.orDie);
            }
            return { stdout: Buffer.alloc(0), stderr: '', durationMs: 1 };
          }).pipe(Effect.onInterrupt(() => Effect.sync(() => stats.interrupted++))),
        stdout: () => Stream.die(new Error('The fake FFmpeg does not stream')),
        lines: () => Stream.die(new Error('The fake FFmpeg does not stream')),
      });
    }),
  );
  return { stats, layer, encoding: Deferred.await(encoding) };
});

type FakeFfmpeg = Effect.Success<ReturnType<typeof fakeFfmpeg>>;

/** What the services under test need besides the database: settings, the fake FFmpeg, and the library. */
function dependencies(files: Fixture, ffmpeg: FakeFfmpeg, settings: Record<string, string>) {
  return Layer.mergeAll(
    testConfig({
      HLS_CACHE_DIR: files.cacheDirectory,
      THUMBNAIL_CACHE_DIR: path.join(files.workspace, 'thumbnails'),
      TRANSCODE_ACCELERATOR: 'software',
      ...settings,
    }),
    ffmpeg.layer,
    // These tests abandon requests and expect the work to stop at once.
    Layer.succeed(SharedWorkGrace, '0 millis'),
    MediaLibrary.layer.pipe(Layer.provideMerge(Disk.layer)),
  );
}

/** A `Transcoding` of its own, released when the effect it is provided to ends. */
const transcoding = (files: Fixture, ffmpeg: FakeFfmpeg, settings: Record<string, string> = {}) =>
  Effect.provide(Layer.fresh(Transcoding.layer).pipe(Layer.provide(dependencies(files, ffmpeg, settings))));

const exists = (file: string) => FileSystem.FileSystem.use((fs) => fs.exists(file));
const entries = (directory: string) => FileSystem.FileSystem.use((fs) => fs.readDirectory(directory));
const temporaryFiles = (directory: string) =>
  Effect.map(entries(directory), (names) => names.filter((name) => name.includes('.tmp.')));

layer(Layer.mergeAll(TestDatabase.layer, NodeServices.layer), { excludeTestServices: true })('Transcoding', (it) => {
  it.effect('prepares a stable session with the detected hardware encoder', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const ffmpeg = yield* fakeFfmpeg();
      const sessions = yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const first = yield* service.startSession(files.media, null);
        const second = yield* service.startSession(files.media, null);
        const english = yield* service.startSession(files.media, 2);
        return { first, second, english };
      }).pipe(transcoding(files, ffmpeg, { TRANSCODE_ACCELERATOR: 'auto' }));
      expect(sessions.first).toEqual(sessions.second);
      expect(sessions.english.sessionId).not.toBe(sessions.first.sessionId);
      const directory = path.join(files.cacheDirectory, sessions.first.sessionId);
      expect((yield* entries(directory)).sort()).toEqual(['master.m3u8', 'session.json']);
      const metadata = JSON.parse(yield* fs.readFileString(path.join(directory, 'session.json')));
      expect(metadata).toMatchObject({ accelerator: 'nvenc', audioStream: null, durationMs: 30_000 });
    }),
  );

  it.effect('runs FFmpeg once for concurrent requests for the same segment', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = yield* fakeFfmpeg();
      yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        const segments = yield* Effect.forEach([1, 2, 3], () => service.hlsFile(sessionId, 'segment-00001.ts'), {
          concurrency: 'unbounded',
        });
        expect(new Set(segments).size).toBe(1);
      }).pipe(transcoding(files, ffmpeg));
      expect(ffmpeg.stats.encodes).toEqual(['libx264']);
    }),
  );

  it.effect('stops FFmpeg and removes its temporary file when the request is abandoned', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = yield* fakeFfmpeg({ gate: yield* Deferred.make<void>() });
      const session = yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        const request = yield* Effect.forkChild(service.hlsFile(sessionId, 'segment-00000.ts'));
        yield* ffmpeg.encoding;
        yield* Fiber.interrupt(request);
        return sessionId;
      }).pipe(transcoding(files, ffmpeg));
      expect(ffmpeg.stats.interrupted).toBe(1);
      expect((yield* entries(path.join(files.cacheDirectory, session))).sort()).toEqual([
        'master.m3u8',
        'session.json',
      ]);
    }),
  );

  it.effect('answers with CapacityExceeded instead of queueing without bound', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const gate = yield* Deferred.make<void>();
      const ffmpeg = yield* fakeFfmpeg({ gate });
      yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        const running = yield* Effect.forkChild(service.hlsFile(sessionId, 'segment-00000.ts'));
        const waiting = yield* Effect.forkChild(service.hlsFile(sessionId, 'segment-00001.ts'));
        yield* ffmpeg.encoding;
        // Nothing announces that the second request joined the waiting list; give it a moment.
        yield* Effect.sleep('20 millis');
        expect(yield* Effect.flip(service.hlsFile(sessionId, 'segment-00002.ts'))).toMatchObject({
          _tag: 'CapacityExceeded',
        });
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(running);
        yield* Fiber.join(waiting);
      }).pipe(transcoding(files, ffmpeg, { MAX_CONCURRENT_TRANSCODES: '1', TRANSCODE_MAX_WAITING: '1' }));
      expect(ffmpeg.stats.encodes).toHaveLength(2);
    }),
  );

  it.effect('falls back to software when the hardware encoder fails, and keeps using software', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = yield* fakeFfmpeg({ failEncoders: ['h264_nvenc'] });
      yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        yield* service.hlsFile(sessionId, 'segment-00000.ts');
        yield* service.hlsFile(sessionId, 'segment-00001.ts');
      }).pipe(transcoding(files, ffmpeg, { TRANSCODE_ACCELERATOR: 'nvenc' }));
      expect(ffmpeg.stats.encodes).toEqual(['h264_nvenc', 'libx264', 'libx264']);
    }),
  );

  it.effect('does not blame the hardware encoder for a timeout', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = yield* fakeFfmpeg({ timeoutEncoders: ['h264_nvenc'] });
      yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        expect(yield* Effect.flip(service.hlsFile(sessionId, 'segment-00000.ts'))).toMatchObject({
          _tag: 'TranscodeTimedOut',
        });
        yield* Effect.flip(service.hlsFile(sessionId, 'segment-00001.ts'));
      }).pipe(transcoding(files, ffmpeg, { TRANSCODE_ACCELERATOR: 'nvenc' }));
      expect(ffmpeg.stats.encodes).toEqual(['h264_nvenc', 'h264_nvenc']);
    }),
  );

  it.effect('does not blame the hardware encoder when software fails the segment too', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = yield* fakeFfmpeg({ failEncoders: ['h264_nvenc', 'libx264'] });
      yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        expect(yield* Effect.flip(service.hlsFile(sessionId, 'segment-00000.ts'))).toMatchObject({
          _tag: 'TranscodeFailed',
        });
        yield* Effect.flip(service.hlsFile(sessionId, 'segment-00001.ts'));
      }).pipe(transcoding(files, ffmpeg, { TRANSCODE_ACCELERATOR: 'nvenc' }));
      expect(ffmpeg.stats.encodes).toEqual(['h264_nvenc', 'libx264', 'h264_nvenc', 'libx264']);
    }),
  );

  it.effect('tries a hardware encoder that failed again after ten minutes', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = yield* fakeFfmpeg({ failEncoders: ['h264_nvenc'] });
      yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const first = yield* service.startSession(files.media, null);
        yield* service.hlsFile(first.sessionId, 'segment-00000.ts');
        // The failure is remembered: a new session starts on software.
        const benched = yield* service.startSession(files.media, 1);
        yield* service.hlsFile(benched.sessionId, 'segment-00000.ts');
        yield* TestClock.adjust('11 minutes');
        const retried = yield* service.startSession(files.media, 2);
        yield* service.hlsFile(retried.sessionId, 'segment-00000.ts');
      }).pipe(transcoding(files, ffmpeg, { TRANSCODE_ACCELERATOR: 'nvenc' }), Effect.provide(TestClock.layer()));
      expect(ffmpeg.stats.encodes).toEqual(['h264_nvenc', 'libx264', 'libx264', 'h264_nvenc', 'libx264']);
    }),
  );

  it.effect('uses software when detection finds no hardware encoder', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = yield* fakeFfmpeg({ missingEncoders: ['h264_nvenc', 'h264_qsv'] });
      yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        yield* service.hlsFile(sessionId, 'segment-00000.ts');
      }).pipe(transcoding(files, ffmpeg, { TRANSCODE_ACCELERATOR: 'auto' }));
      expect(ffmpeg.stats.encodes).toEqual(['libx264']);
    }),
  );

  it.effect('fails with TranscodeFailed, leaves no temporary file, and retries on the next request', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = yield* fakeFfmpeg({ failEncoders: ['libx264'] });
      yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        expect(yield* Effect.flip(service.hlsFile(sessionId, 'segment-00000.ts'))).toMatchObject({
          _tag: 'TranscodeFailed',
        });
        expect(yield* temporaryFiles(path.join(files.cacheDirectory, sessionId))).toEqual([]);
        yield* Effect.flip(service.hlsFile(sessionId, 'segment-00000.ts'));
      }).pipe(transcoding(files, ffmpeg));
      expect(ffmpeg.stats.encodes).toEqual(['libx264', 'libx264']);
    }),
  );

  it.effect('reports a source file that changed after the session started', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const ffmpeg = yield* fakeFfmpeg();
      yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        yield* fs.writeFileString(files.mediaFile, 'a different, longer file');
        expect(yield* Effect.flip(service.hlsFile(sessionId, 'segment-00000.ts'))).toMatchObject({
          _tag: 'MediaChanged',
        });
      }).pipe(transcoding(files, ffmpeg));
    }),
  );

  it.effect('rejects invalid names, out-of-range segments, and corrupt session metadata', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const ffmpeg = yield* fakeFfmpeg();
      yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        for (const [session, file] of [
          ['not-a-session', 'master.m3u8'],
          [sessionId, '../session.json'],
          [sessionId, 'segment-00099.ts'],
          ['a'.repeat(64), 'segment-00000.ts'],
        ])
          expect(yield* Effect.flip(service.hlsFile(session, file))).toMatchObject({ _tag: 'HlsFileNotFound' });
        yield* fs.writeFileString(path.join(files.cacheDirectory, sessionId, 'session.json'), '{"mediaId":1}');
        expect(yield* Effect.flip(service.hlsFile(sessionId, 'segment-00000.ts'))).toMatchObject({
          _tag: 'HlsFileNotFound',
        });
      }).pipe(transcoding(files, ffmpeg));
    }),
  );

  it.effect('evicts old sessions from the cache but never a session in use', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const ffmpeg = yield* fakeFfmpeg();
      const stale = path.join(files.cacheDirectory, 'b'.repeat(64));
      yield* fs.makeDirectory(stale, { recursive: true });
      yield* fs.writeFileString(path.join(stale, 'segment-00000.ts'), 'old');
      const longAgo = new Date(Date.now() - 48 * 3_600_000);
      yield* fs.utimes(stale, longAgo, longAgo);

      yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        const active = path.join(files.cacheDirectory, sessionId);
        yield* fs.utimes(active, longAgo, longAgo);
        // Starting another session runs cleanup: the active session is protected despite its age.
        yield* service.startSession(files.media, 1);
        // Cleanup runs in the background; wait for it to remove the stale session.
        yield* exists(stale).pipe(
          Effect.filterOrFail((present) => !present),
          Effect.retry({ schedule: Schedule.spaced('10 millis'), times: 100 }),
        );
        expect(yield* exists(active)).toBe(true);
      }).pipe(transcoding(files, ffmpeg, { HLS_CACHE_MAX_AGE_HOURS: '24' }));
    }),
  );

  it.effect('ends pending work when the service is released', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = yield* fakeFfmpeg({ gate: yield* Deferred.make<void>() });
      const request = yield* Effect.gen(function* () {
        const service = yield* Transcoding.Service;
        const { sessionId } = yield* service.startSession(files.media, null);
        const request = yield* Effect.forkDetach(service.hlsFile(sessionId, 'segment-00000.ts'));
        yield* ffmpeg.encoding;
        return request;
      }).pipe(transcoding(files, ffmpeg));
      const exit = yield* Fiber.await(request);
      expect(ffmpeg.stats.interrupted).toBe(1);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

layer(Layer.mergeAll(TestDatabase.layer, NodeServices.layer), { excludeTestServices: true })('Thumbnails', (it) => {
  /** A `Thumbnails` of its own, released when the effect it is provided to ends. */
  const thumbnails = (files: Fixture, ffmpeg: FakeFfmpeg) =>
    Effect.provide(Layer.fresh(Thumbnails.layer).pipe(Layer.provide(dependencies(files, ffmpeg, {}))));
  const seekOf = (args: readonly string[]) => args[args.indexOf('-ss') + 1];

  it.effect('extracts each frame once, clamps the position to the media, and serves later requests from disk', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = yield* fakeFfmpeg();
      const [first, again, clamped] = yield* Effect.gen(function* () {
        const service = yield* Thumbnails.Service;
        const concurrent = yield* Effect.forEach([1, 2], () => service.thumbnailAt(files.mediaId, 5_000), {
          concurrency: 'unbounded',
        });
        expect(concurrent[0].key).toBe(concurrent[1].key);
        return [
          concurrent[0],
          yield* service.thumbnailAt(files.mediaId, 5_000),
          yield* service.thumbnailAt(files.mediaId, 90_000),
        ];
      }).pipe(thumbnails(files, ffmpeg));
      expect(new TextDecoder().decode(first.contents)).toBe('segment by frame');
      expect(again.key).toBe(first.key);
      expect(clamped.key).not.toBe(first.key);
      expect(ffmpeg.stats.runs.map(seekOf)).toEqual(['5.000', '29.000']);
      expect(yield* temporaryFiles(path.join(files.workspace, 'thumbnails'))).toEqual([]);
    }),
  );

  it.effect('reports a frame FFmpeg cannot extract as ThumbnailFailed', () =>
    Effect.gen(function* () {
      const files = yield* fixture;
      const ffmpeg = yield* fakeFfmpeg({ failEncoders: ['frame'] });
      yield* Effect.gen(function* () {
        const service = yield* Thumbnails.Service;
        expect(yield* Effect.flip(service.thumbnailAt(files.mediaId, 0))).toMatchObject({ _tag: 'ThumbnailFailed' });
      }).pipe(thumbnails(files, ffmpeg));
    }),
  );
});
