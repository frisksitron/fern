import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MediaProcessRunner, ProcessExited, type ProcessRequest } from '../../src/lib/server/media/process-runner';
import { MediaRootRepository } from '../../src/lib/server/media-roots/repository';
import { FileSystem } from '../../src/lib/server/platform/filesystem';
import { ScanEvents } from '../../src/lib/server/scans/events';
import { ScanQueuePolicy } from '../../src/lib/server/scans/jobs';
import { Scanner } from '../../src/lib/server/scans/scanner';
import { Scans } from '../../src/lib/server/scans/service';
import { ScanWorker } from '../../src/lib/server/scans/worker';
import { YouTubeDownloads } from '../../src/lib/server/youtube/service';
import type { YouTubeDownloadId } from '../../src/lib/shared/contracts/ids';
import { testConfig } from '../support/config';
import { createTestDatabase, type TestDatabase } from './support/database';

let database: TestDatabase;
let downloads: string;
let runtime: ManagedRuntime.ManagedRuntime<YouTubeDownloads, never> | null = null;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await database.pool.query('truncate youtube_downloads, scan_runs, media_roots cascade');
  downloads = await mkdtemp(path.join(tmpdir(), 'fern-youtube-'));
});

afterEach(async () => {
  await runtime?.dispose();
  runtime = null;
  await rm(downloads, { recursive: true, force: true });
});

/**
 * yt-dlp and ffprobe stand-ins. yt-dlp saves a file into the library it is given and reports it as
 * the real one does; a video ID starting with "private" fails like a private video. ffprobe answers
 * every file as a two-chapter Opus mix.
 */
const fakeRunner = Layer.succeed(MediaProcessRunner, {
  run: (request: ProcessRequest) =>
    Effect.gen(function* () {
      if (request.program === 'ffprobe') {
        const probe = {
          format: { duration: '600.0', format_name: 'ogg' },
          streams: [
            { index: 0, codec_type: 'audio', codec_name: 'opus', tags: { title: 'Late Mix', ARTIST: 'Chrysalis' } },
          ],
          chapters: [
            { start_time: '0', end_time: '200', tags: { title: 'Intro' } },
            { start_time: '200', end_time: '600', tags: { title: 'Second Song' } },
          ],
        };
        return { stdout: Buffer.from(JSON.stringify(probe)), stderr: '', durationMs: 1 };
      }
      const url = request.args.at(-1)!;
      const videoId = new URL(url).searchParams.get('v')!;
      yield* Effect.sleep('100 millis');
      if (videoId.startsWith('private'))
        return yield* new ProcessExited({
          program: 'yt-dlp',
          code: 1,
          signal: null,
          stderr: `ERROR: [youtube] ${videoId}: Private video. Sign in if you've been granted access to this video`,
        });
      const home = request.args.find((arg) => arg.startsWith('home:'))!.slice('home:'.length);
      const file = path.join(home, 'Chrysalis', `Late Mix [${videoId}].opus`);
      yield* Effect.promise(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, 'opus');
        await writeFile(file.replace(/\.opus$/, '.jpg'), 'jpeg');
      });
      request.onStdout?.(
        Buffer.from(
          [
            '[youtube] Extracting URL',
            '[fern:info] {"title": "Late Mix", "channel": "Chrysalis", "uploader": "chrysalis", "duration": 600}',
            '[fern:progress] 2 4',
            '[fern:progress] 4 4',
            `[fern:saved] ${file}`,
            '',
          ].join('\n'),
        ),
      );
      return { stdout: Buffer.alloc(0), stderr: '', durationMs: 100 };
    }),
});

async function start() {
  const infrastructure = Layer.mergeAll(
    database.layer,
    ScanEvents.layer,
    FileSystem.layer,
    fakeRunner,
    testConfig({ DOWNLOADS_DIR: downloads }),
    Layer.succeed(ScanQueuePolicy, {
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
    }),
  );
  const scans = Scans.layerWithoutDependencies.pipe(
    Layer.provide(ScanWorker.layerWithoutDependencies),
    Layer.provide(Scanner.layerWithoutDependencies),
  );
  const layer = YouTubeDownloads.layerWithoutDependencies.pipe(
    Layer.provide(Layer.mergeAll(scans, MediaRootRepository.layer)),
    Layer.provide(infrastructure),
  );
  runtime = ManagedRuntime.make(layer);
  await runtime.context();
  const current = runtime;
  return <A, E>(use: (service: YouTubeDownloads['Service']) => Effect.Effect<A, E>) =>
    current.runPromise(Effect.result(YouTubeDownloads.use(use)));
}

type Row = Record<string, unknown>;

async function download(id: string) {
  return (await database.pool.query<Row>('select * from youtube_downloads where id = $1', [id])).rows[0];
}

async function waitForState(id: string, state: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await download(id);
    if (row?.state === state) return row;
    if (Date.now() > deadline) throw new Error(`Download ${id} is ${String(row?.state)}, not ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('YouTubeDownloads', () => {
  it('creates the YouTube library on startup', async () => {
    await start();
    // Startup does not wait for the database, so the library appears shortly after.
    await expect
      .poll(async () => (await database.pool.query('select path, source, media_type from media_roots')).rows)
      .toEqual([{ path: await realpath(downloads), source: 'youtube', media_type: 'music' }]);
  });

  it('saves a video into the library and links it to its song and chapters', async () => {
    const use = await start();
    const started = await use((service) => service.start('https://youtu.be/abcdefghijk?si=share'));
    if (started._tag !== 'Success') throw new Error('The download did not start');

    const row = await waitForState(started.success, 'completed');
    expect(row).toMatchObject({
      video_id: 'abcdefghijk',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      title: 'Late Mix',
      channel: 'Chrysalis',
      duration_ms: '600000',
      downloaded_bytes: '4',
      total_bytes: '4',
      relative_path: 'Chrysalis/Late Mix [abcdefghijk].opus',
      error_message: null,
    });
    const song = await database.pool.query(
      `select e.title, e.artist, a.name as artwork, (select count(*)::int from media_chapters c where c.media_entry_id = e.id) as chapters
       from media_entries e left join media_entries a on a.id = e.artwork_media_entry_id where e.id = $1`,
      [row!.media_entry_id],
    );
    expect(song.rows).toEqual([
      { title: 'Late Mix', artist: 'Chrysalis', artwork: 'Late Mix [abcdefghijk].jpg', chapters: 2 },
    ]);
  });

  it('downloads a video once at a time and rejects links that are not one video', async () => {
    const use = await start();
    const first = await use((service) => service.start('https://www.youtube.com/watch?v=abcdefghijk'));
    expect(first._tag).toBe('Success');
    expect(await use((service) => service.start('https://youtu.be/abcdefghijk'))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'YouTubeDownloadActive' },
    });
    expect(await use((service) => service.start('https://www.youtube.com/playlist?list=PL1'))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'InvalidYouTubeUrl' },
    });
  });

  it('records why a download failed and retries it on request', async () => {
    const use = await start();
    const started = await use((service) => service.start('https://youtu.be/privateVid1'));
    if (started._tag !== 'Success') throw new Error('The download did not start');
    expect(await waitForState(started.success, 'failed')).toMatchObject({ error_message: 'This video is private.' });

    expect(await use((service) => service.retry(started.success))).toMatchObject({ _tag: 'Success' });
    expect(await waitForState(started.success, 'failed')).toMatchObject({ error_message: 'This video is private.' });
    expect(
      await use((service) => service.retry('00000000-0000-4000-8000-000000000000' as YouTubeDownloadId)),
    ).toMatchObject({ _tag: 'Failure', failure: { _tag: 'YouTubeDownloadNotFound' } });
  });

  it('removes a download from the list without removing its song', async () => {
    const use = await start();
    const started = await use((service) => service.start('https://youtu.be/abcdefghijk'));
    if (started._tag !== 'Success') throw new Error('The download did not start');
    const row = await waitForState(started.success, 'completed');

    expect(await use((service) => service.dismiss(started.success))).toMatchObject({ _tag: 'Success' });
    expect(await download(started.success)).toBeUndefined();
    const song = await database.pool.query('select deleted_at from media_entries where id = $1', [row!.media_entry_id]);
    expect(song.rows).toEqual([{ deleted_at: null }]);
  });
});
