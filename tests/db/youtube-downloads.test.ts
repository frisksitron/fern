import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { describe, expect, it } from '@effect/vitest';
import { randomUUID } from 'node:crypto';
import { Effect, FileSystem, Layer, Ref, Schedule, Stream } from 'effect';
import { SqlClient } from 'effect/sql';
import { MediaProbe } from '../../src/lib/server/media/probe';
import { MediaProcess, ProcessExited } from '../../src/lib/server/media/process';
import { MediaRootRepository } from '../../src/lib/server/media-roots/repository';
import { Disk } from '../../src/lib/server/platform/disk';
import { ScanEvents } from '../../src/lib/server/scans/events';
import { ScanQueuePolicy } from '../../src/lib/server/scans/jobs';
import { Scanner } from '../../src/lib/server/scans/scanner';
import { Scans } from '../../src/lib/server/scans/service';
import { ScanWorker } from '../../src/lib/server/scans/worker';
import { YouTubeDownloads } from '../../src/lib/server/youtube/service';
import { ScanId, type YouTubeDownloadId } from '../../src/lib/shared/contracts/ids';
import type { ScanRun } from '../../src/lib/shared/contracts/scans';
import { testConfig } from '../support/config';
import { TestDatabase } from './support/database';

/** ffprobe's answer for every file: a two-chapter Opus mix. */
const probe = {
  format: { duration: '600.0', format_name: 'ogg' },
  streams: [{ index: 0, codec_type: 'audio', codec_name: 'opus', tags: { title: 'Late Mix', ARTIST: 'Chrysalis' } }],
  chapters: [
    { start_time: '0', end_time: '200', tags: { title: 'Intro' } },
    { start_time: '200', end_time: '600', tags: { title: 'Second Song' } },
  ],
};

/**
 * yt-dlp and ffprobe stand-ins. yt-dlp saves a file into the library it is given and reports it as
 * the real one does. A video ID starting with "private" fails like a private video; "slow" never
 * finishes, leaving a partial file in the staging folder; "outside", "dotfolder", and "missing"
 * report a file outside the library, in a hidden folder, and one that does not exist.
 */
const fakeProcess = Layer.mock(MediaProcess.Service, {
  run: () => Effect.succeed({ stdout: Buffer.from(JSON.stringify(probe)), stderr: '', durationMs: 1 }),
  lines: (request) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const videoId = new URL(request.args.at(-1)!).searchParams.get('v')!;
        yield* Effect.sleep('100 millis');
        if (videoId.startsWith('private'))
          return yield* new ProcessExited({
            program: 'yt-dlp',
            code: 1,
            stderr: `ERROR: [youtube] ${videoId}: Private video. Sign in if you've been granted access to this video`,
          });
        const home = request.args.find((arg) => arg.startsWith('home:'))!.slice('home:'.length);
        const staging = request.args.find((arg) => arg.startsWith('temp:'))!.slice('temp:'.length);
        const info =
          '[fern:info] {"title": "Late Mix", "channel": "Chrysalis", "uploader": "chrysalis", "duration": 600}';
        if (videoId.startsWith('slow')) {
          yield* Effect.promise(async () => {
            await mkdir(staging, { recursive: true });
            await writeFile(path.join(staging, 'partial.part'), 'opus');
          });
          return Stream.make(info).pipe(Stream.concat(Stream.never));
        }
        const reported = videoId.startsWith('outside')
          ? path.join(home, '..', `Late Mix [${videoId}].opus`)
          : videoId.startsWith('dotfolder')
            ? path.join(home, '.Chrysalis', `Late Mix [${videoId}].opus`)
            : videoId.startsWith('missing')
              ? path.join(home, 'Chrysalis', `Not Saved [${videoId}].opus`)
              : null;
        if (reported) return Stream.make(info, `[fern:saved] ${reported}`);
        const file = path.join(home, 'Chrysalis', `Late Mix [${videoId}].opus`);
        yield* Effect.promise(async () => {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, 'opus');
          await writeFile(file.replace(/\.opus$/, '.jpg'), 'jpeg');
        });
        return Stream.make(
          '[youtube] Extracting URL',
          info,
          '[fern:progress] 2 4',
          '[fern:progress] 4 4',
          `[fern:saved] ${file}`,
        );
      }),
    ),
});

const fastScans = Layer.succeed(ScanQueuePolicy, {
  maxAttempts: 1,
  retryBaseDelay: '10 millis',
  retryMaxDelay: '10 millis',
  pollInterval: '50 millis',
  lockExpiration: '10 seconds',
  lockRefreshInterval: '1 second',
  leadershipRetryInterval: '50 millis',
  maintenanceInterval: '1 second',
  completedRetention: '1 day',
  failedRetention: '1 day',
  cleanupInterval: '1 hour',
});

const realScans = Scans.layer.pipe(Layer.provide(ScanWorker.layer), Layer.provide(Scanner.layer));

/** Scans that are accepted and then fail, counting how many were started. */
const failingScans = (starts: Ref.Ref<number>) =>
  Layer.mock(Scans.Service, {
    start: () => Ref.update(starts, (count) => count + 1).pipe(Effect.as(ScanId.make(randomUUID()))),
    get: () => Effect.succeed({ state: 'failed' } as ScanRun),
  });

/** YouTube downloads on a fresh database, saving into `downloads`, with real scans of the library. */
function downloadsOn(downloads: string, scansLayer = realScans) {
  const infrastructure = Layer.mergeAll(
    ScanEvents.layer,
    Disk.layer,
    NodeServices.layer,
    MediaProbe.layer.pipe(Layer.provide(fakeProcess)),
    fakeProcess,
    testConfig({ DOWNLOADS_DIR: downloads }),
    fastScans,
  ).pipe(Layer.provideMerge(TestDatabase.layer));
  return YouTubeDownloads.layer.pipe(
    Layer.provide(Layer.mergeAll(scansLayer, MediaRootRepository.layer)),
    Layer.provideMerge(infrastructure),
  );
}

/** Runs a test with its own downloads folder and a YouTube downloads service started on it. */
const withDownloads = <A, E>(
  test: (
    downloads: string,
  ) => Effect.Effect<A, E, YouTubeDownloads.Service | SqlClient.SqlClient | FileSystem.FileSystem>,
  scansLayer = realScans,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const downloads = yield* fs.makeTempDirectoryScoped({ prefix: 'fern-youtube-' });
    return yield* test(downloads).pipe(Effect.provide(downloadsOn(downloads, scansLayer)));
  }).pipe(Effect.provide(NodeServices.layer));

type Row = Record<string, unknown>;

const downloadRow = (id: string) =>
  SqlClient.SqlClient.use((sql) => sql<Row>`select * from youtube_downloads where id = ${id}`).pipe(
    Effect.map((rows) => rows[0]),
  );

/** The download's row once it reaches `state`, checked every 50 ms for up to 15 seconds. */
const waitForState = (id: string, state: string) =>
  downloadRow(id).pipe(
    Effect.filterOrFail(
      (row) => row?.state === state,
      (row) => new Error(`Download ${id} is ${String(row?.state)}, not ${state}`),
    ),
    Effect.retry({ schedule: Schedule.spaced('50 millis'), times: 300 }),
  );

describe('YouTubeDownloads', () => {
  it.live('creates the YouTube library on startup', () =>
    withDownloads((downloads) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sql = yield* SqlClient.SqlClient;
        const expected = [{ path: yield* fs.realPath(downloads), source: 'youtube', media_type: 'music' }];
        // Startup does not wait for the database, so the library appears shortly after.
        const roots = yield* sql`select path, source, media_type from media_roots`.pipe(
          Effect.repeat({ schedule: Schedule.spaced('50 millis'), until: (rows) => rows.length > 0, times: 100 }),
        );
        expect(roots).toEqual(expected);
      }),
    ),
  );

  it.live('saves a video into the library and links it to its song and chapters', () =>
    withDownloads(() =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* YouTubeDownloads.Service;
        const id = yield* service.start('https://youtu.be/abcdefghijk?si=share');

        const row = yield* waitForState(id, 'completed');
        expect(row).toMatchObject({
          video_id: 'abcdefghijk',
          url: 'https://www.youtube.com/watch?v=abcdefghijk',
          title: 'Late Mix',
          channel: 'Chrysalis',
          relative_path: 'Chrysalis/Late Mix [abcdefghijk].opus',
          error_message: null,
        });
        expect([row!.duration_ms, row!.downloaded_bytes, row!.total_bytes].map(Number)).toEqual([600_000, 4, 4]);
        const song = yield* sql`select e.title, e.artist, a.name as artwork,
            (select count(*)::int from media_chapters c where c.media_entry_id = e.id) as chapters
          from media_entries e left join media_entries a on a.id = e.artwork_media_entry_id
          where e.id = ${row!.media_entry_id as string}`;
        expect(song).toEqual([
          { title: 'Late Mix', artist: 'Chrysalis', artwork: 'Late Mix [abcdefghijk].jpg', chapters: 2 },
        ]);
      }),
    ),
  );

  it.live('downloads a video once at a time and rejects links that are not one video', () =>
    withDownloads(() =>
      Effect.gen(function* () {
        const service = yield* YouTubeDownloads.Service;
        yield* service.start('https://www.youtube.com/watch?v=abcdefghijk');
        expect(yield* Effect.flip(service.start('https://youtu.be/abcdefghijk'))).toMatchObject({
          _tag: 'YouTubeDownloadActive',
        });
        expect(yield* Effect.flip(service.start('https://www.youtube.com/playlist?list=PL1'))).toMatchObject({
          _tag: 'InvalidYouTubeUrl',
        });
      }),
    ),
  );

  it.live('records why a download failed and retries it on request', () =>
    withDownloads(() =>
      Effect.gen(function* () {
        const service = yield* YouTubeDownloads.Service;
        const id = yield* service.start('https://youtu.be/privateVid1');
        expect(yield* waitForState(id, 'failed')).toMatchObject({ error_message: 'This video is private.' });

        yield* service.retry(id);
        expect(yield* waitForState(id, 'failed')).toMatchObject({ error_message: 'This video is private.' });
        const unknown = service.retry('00000000-0000-4000-8000-000000000000' as YouTubeDownloadId);
        expect(yield* Effect.flip(unknown)).toMatchObject({ _tag: 'YouTubeDownloadNotFound' });
      }),
    ),
  );

  it.live('removes a download from the list without removing its song', () =>
    withDownloads(() =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* YouTubeDownloads.Service;
        const id = yield* service.start('https://youtu.be/abcdefghijk');
        const row = yield* waitForState(id, 'completed');

        yield* service.dismiss(id);
        expect(yield* downloadRow(id)).toBeUndefined();
        expect(yield* sql`select deleted_at from media_entries where id = ${row!.media_entry_id as string}`).toEqual([
          { deleted_at: null },
        ]);
      }),
    ),
  );

  it.live('stops a running download when it is dismissed and goes on with the queue', () =>
    withDownloads((downloads) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const service = yield* YouTubeDownloads.Service;
        const slow = yield* service.start('https://youtu.be/slowVideo01');
        // The title is written once yt-dlp is running and has reported the video.
        yield* downloadRow(slow).pipe(
          Effect.filterOrFail(
            (row) => row?.title === 'Late Mix',
            () => new Error('yt-dlp has not started'),
          ),
          Effect.retry({ schedule: Schedule.spaced('50 millis'), times: 300 }),
        );
        const staging = path.join(yield* fs.realPath(downloads), '.downloading', slow);
        expect(yield* fs.exists(staging)).toBe(true);

        yield* service.dismiss(slow);
        expect(yield* downloadRow(slow)).toBeUndefined();
        expect(yield* fs.exists(staging)).toBe(false);
        expect(yield* Effect.flip(service.dismiss(slow))).toMatchObject({ _tag: 'YouTubeDownloadNotFound' });

        // The stopped download no longer holds the downloader, and nothing brings its row back.
        const next = yield* service.start('https://youtu.be/abcdefghijk');
        yield* downloadRow(next).pipe(
          Effect.filterOrFail(
            (row) => row?.state === 'indexing' || row?.state === 'completed',
            (row) => new Error(`Download ${next} is ${String(row?.state)}`),
          ),
          Effect.retry({ schedule: Schedule.spaced('50 millis'), times: 300 }),
        );
        expect(yield* downloadRow(slow)).toBeUndefined();
      }),
    ),
  );

  for (const [place, videoId] of [
    ['outside the library', 'outsideVid1'],
    ['a hidden folder', 'dotfolder01'],
  ] as const)
    it.live(`fails a download whose file is saved in ${place}`, () =>
      withDownloads(() =>
        Effect.gen(function* () {
          const service = yield* YouTubeDownloads.Service;
          const id = yield* service.start(`https://youtu.be/${videoId}`);
          expect(yield* waitForState(id, 'failed')).toMatchObject({
            relative_path: null,
            media_entry_id: null,
            error_message: 'The video was downloaded, but Fern could not use the file yt-dlp saved.',
          });
        }),
      ),
    );

  it.live('fails a download whose file the library scan did not find', () =>
    withDownloads(() =>
      Effect.gen(function* () {
        const service = yield* YouTubeDownloads.Service;
        const id = yield* service.start('https://youtu.be/missingVid1');
        expect(yield* waitForState(id, 'failed')).toMatchObject({
          relative_path: 'Chrysalis/Not Saved [missingVid1].opus',
          media_entry_id: null,
          completed_at: null,
          error_message: 'The video was saved, but the library scan did not add it. Try the download again.',
        });
      }),
    ),
  );

  it.live('leaves a download indexing when the library scan fails, without scanning in a loop', () =>
    Effect.gen(function* () {
      const starts = yield* Ref.make(0);
      yield* withDownloads(
        () =>
          Effect.gen(function* () {
            const service = yield* YouTubeDownloads.Service;
            const id = yield* service.start('https://youtu.be/abcdefghijk');
            yield* Ref.get(starts).pipe(
              Effect.filterOrFail(
                (count) => count > 0,
                () => new Error('No scan started'),
              ),
              Effect.retry({ schedule: Schedule.spaced('50 millis'), times: 300 }),
            );
            // The indexer waits before it tries again.
            yield* Effect.sleep('500 millis');
            expect(yield* Ref.get(starts)).toBe(1);
            expect(yield* downloadRow(id)).toMatchObject({
              state: 'indexing',
              relative_path: 'Chrysalis/Late Mix [abcdefghijk].opus',
              completed_at: null,
              error_message: null,
            });
          }),
        failingScans(starts),
      );
    }),
  );
});
