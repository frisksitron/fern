import { randomUUID } from 'node:crypto';
import { mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Cause, Context, Effect, Exit, Fiber, FiberSet, Layer, Option, Queue, Schedule, Semaphore } from 'effect';
import { FernConfig } from '$lib/server/config';
import { mediaEntries, youtubeDownloads } from '$lib/server/db/schema';
import { Database, orUnavailable, uniqueViolation, type DatabaseUnavailable } from '$lib/server/db/service';
import { MediaProcessRunner, type ProcessError } from '$lib/server/media/process-runner';
import { MediaRootRepository } from '$lib/server/media-roots/repository';
import { Scans } from '$lib/server/scans/service';
import { isTerminalScanState } from '$lib/server/scans/state';
import { YouTubeDownloadId, type MediaRootId, type ScanId } from '$lib/shared/contracts/ids';
import { youtubeVideoId, youtubeWatchUrl } from '$lib/shared/youtube';
import {
  InvalidYouTubeUrl,
  YouTubeDownloadActive,
  YouTubeDownloadNotFailed,
  YouTubeDownloadNotFound,
  YouTubeLibraryUnavailable,
} from './errors';
import { describeYtDlpFailure, lineReader, parseYtDlpLine, ytDlpArgs } from './yt-dlp';

type Download = typeof youtubeDownloads.$inferSelect;
type Library = { readonly path: string; readonly rootId: MediaRootId };

/** Partial downloads, inside the library but hidden from scans like every dot-folder. */
const STAGING_DIRECTORY = '.downloading';
/** A download that takes longer is stopped. Long mixes at a slow connection still fit. */
const DOWNLOAD_TIMEOUT = '4 hours';
/** Progress is written at most this often; Zero carries it to the page. */
const PROGRESS_INTERVAL = '1 second';
/** How often a download waiting to be indexed checks whether its scan has finished. */
const SCAN_POLL_INTERVAL = '2 seconds';
/** Downloads are announced by `wake`; this is only a fallback. */
const IDLE_POLL_INTERVAL = '1 minute';

function describeProcessFailure(error: ProcessError) {
  switch (error._tag) {
    case 'ProcessExited':
      return describeYtDlpFailure(error.stderr);
    case 'ProcessSpawnFailed':
      return 'yt-dlp is not installed, or Fern could not start it.';
    case 'ProcessTimedOut':
      return 'The download took too long and was stopped.';
    case 'ProcessOutputTooLarge':
      return 'yt-dlp could not download this video.';
  }
}

/**
 * Saves the audio of YouTube videos into the YouTube library: a music root of Fern's own at
 * `DOWNLOADS_DIR`, created on startup, which users cannot remove. One video downloads at a time;
 * each saved file is then indexed by a scan of that root, which also reads the video's chapters
 * from the file. Progress lives in `youtube_downloads`, which Zero synchronizes to the page.
 *
 * Downloads a previous process left unfinished start again on startup, and yt-dlp resumes their
 * partial files.
 */
export class YouTubeDownloads extends Context.Service<YouTubeDownloads>()('fern/YouTubeDownloads', {
  make: Effect.gen(function* () {
    const db = yield* Database;
    const config = yield* FernConfig;
    const runner = yield* MediaProcessRunner;
    const repository = yield* MediaRootRepository;
    const scans = yield* Scans;
    const jobs = yield* FiberSet.make<void>();
    const downloadWakeups = yield* Queue.sliding<void>(1);
    const indexWakeups = yield* Queue.sliding<void>(1);
    const libraryLock = yield* Semaphore.make(1);
    let library: Library | null = null;
    let current: { readonly id: string; readonly fiber: Fiber.Fiber<void> } | null = null;

    const ffmpegLocation = /[\\/]/.test(config.FFMPEG_PATH) ? path.resolve(config.FFMPEG_PATH) : null;

    const update = (id: string, fields: Partial<typeof youtubeDownloads.$inferInsert>) =>
      orUnavailable(
        db
          .update(youtubeDownloads)
          .set({ ...fields, updatedAt: sql`now()` })
          .where(eq(youtubeDownloads.id, id)),
      );

    /** The library's folder and root, created the first time they are needed. */
    const ensureLibrary: Effect.Effect<Library, YouTubeLibraryUnavailable> = libraryLock.withPermits(1)(
      Effect.suspend(() => {
        if (library) return Effect.succeed(library);
        return Effect.gen(function* () {
          const directory = yield* Effect.tryPromise(async () => {
            await mkdir(config.DOWNLOADS_DIR, { recursive: true });
            return realpath(config.DOWNLOADS_DIR);
          });
          const rootId = yield* repository.ensureYouTubeRoot(directory);
          library = { path: directory, rootId };
          yield* Effect.logInfo('YouTube library ready').pipe(Effect.annotateLogs({ path: directory, rootId }));
          return library;
        }).pipe(Effect.mapError((cause) => new YouTubeLibraryUnavailable({ cause })));
      }),
    );

    const stagingPath = (libraryPath: string, id: string) => path.join(libraryPath, STAGING_DIRECTORY, id);
    const removeStaging = (id: string) =>
      Effect.suspend(() =>
        library
          ? Effect.promise(() => rm(stagingPath(library!.path, id), { recursive: true, force: true }))
          : Effect.void,
      ).pipe(Effect.ignore);

    /** Runs yt-dlp for one download and records what it reports. Returns the saved file's library path. */
    const fetchAudio = (download: Download, target: Library) =>
      Effect.scoped(
        Effect.gen(function* () {
          const reported = {
            info: null as { title: string | null; channel: string | null; durationMs: number | null } | null,
            downloadedBytes: null as number | null,
            totalBytes: null as number | null,
            savedPath: null as string | null,
            changed: false,
          };
          const lines = lineReader((line) => {
            const event = parseYtDlpLine(line);
            if (!event) return;
            if (event.type === 'info')
              reported.info = { title: event.title, channel: event.channel, durationMs: event.durationMs };
            else if (event.type === 'progress') {
              reported.downloadedBytes = event.downloadedBytes;
              reported.totalBytes = event.totalBytes;
            } else reported.savedPath = event.path;
            reported.changed = true;
          });
          const flush = Effect.suspend(() => {
            if (!reported.changed) return Effect.void;
            reported.changed = false;
            return update(download.id, {
              ...(reported.info ?? {}),
              downloadedBytes: reported.downloadedBytes,
              totalBytes: reported.totalBytes,
            });
          }).pipe(
            // Progress is only for show; a missed update is replaced by the next one.
            Effect.catchTag('DatabaseUnavailable', () => Effect.void),
          );

          yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(PROGRESS_INTERVAL), flush)));
          yield* runner.run({
            program: 'yt-dlp',
            args: ytDlpArgs({
              url: download.url,
              libraryPath: target.path,
              stagingPath: stagingPath(target.path, download.id),
              nodePath: process.execPath,
              ffmpegLocation,
            }),
            timeout: DOWNLOAD_TIMEOUT,
            onStdout: lines.push,
          });
          lines.end();
          yield* flush;
          return reported.savedPath === null
            ? null
            : path.relative(target.path, reported.savedPath).split(path.sep).join('/');
        }),
      );

    /** Downloads one video, then hands it to the indexer. Interruption leaves the row for a later process. */
    const runDownload = (download: Download) =>
      Effect.gen(function* () {
        yield* Effect.logInfo('YouTube download started');
        const outcome = yield* Effect.exit(
          Effect.gen(function* () {
            const target = yield* ensureLibrary;
            return yield* fetchAudio(download, target);
          }),
        );
        if (Exit.isSuccess(outcome)) {
          yield* update(download.id, { state: 'indexing', relativePath: outcome.value });
          yield* removeStaging(download.id);
          yield* Queue.offer(indexWakeups, undefined);
          yield* Effect.logInfo('YouTube download saved').pipe(Effect.annotateLogs({ file: outcome.value }));
          return;
        }
        if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.interrupt;
        const error = Cause.findErrorOption(outcome.cause);
        const message = Option.isNone(error)
          ? 'The download stopped unexpectedly.'
          : error.value._tag === 'YouTubeLibraryUnavailable'
            ? 'The YouTube library is unavailable. Fern’s log has the details.'
            : describeProcessFailure(error.value);
        yield* Effect.logWarning('YouTube download failed', Cause.pretty(outcome.cause));
        yield* update(download.id, { state: 'failed', errorMessage: message });
      }).pipe(
        Effect.catchTag('DatabaseUnavailable', (error) =>
          Effect.logWarning('Could not record a YouTube download; it runs again after a restart', error.cause),
        ),
        Effect.annotateLogs({ downloadId: download.id, videoId: download.videoId }),
        Effect.withSpan('youtube.download', { attributes: { downloadId: download.id } }),
      );

    const claimNext = Effect.gen(function* () {
      const [next] = yield* orUnavailable(
        db
          .select()
          .from(youtubeDownloads)
          .where(eq(youtubeDownloads.state, 'queued'))
          .orderBy(asc(youtubeDownloads.createdAt))
          .limit(1),
      );
      if (!next) return null;
      const [claimed] = yield* orUnavailable(
        db
          .update(youtubeDownloads)
          .set({ state: 'downloading', errorMessage: null, updatedAt: sql`now()` })
          .where(and(eq(youtubeDownloads.id, next.id), eq(youtubeDownloads.state, 'queued')))
          .returning(),
      );
      return claimed ?? null;
    });

    /** Downloads queued videos one at a time, in the order they were added. */
    const downloader = Effect.gen(function* () {
      const download = yield* claimNext;
      if (!download) {
        yield* Queue.take(downloadWakeups).pipe(Effect.timeoutOption(IDLE_POLL_INTERVAL));
        return;
      }
      const fiber = yield* FiberSet.run(jobs, runDownload(download));
      current = { id: download.id, fiber };
      yield* Fiber.await(fiber).pipe(Effect.ensuring(Effect.sync(() => (current = null))));
    });

    /** Waits for a scan to finish, however it ends. */
    const awaitScan = (scanId: ScanId) =>
      scans.get(scanId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced(SCAN_POLL_INTERVAL),
          until: (scan) => isTerminalScanState(scan.state),
        }),
      );

    /**
     * Adds saved files to the library: one scan of the YouTube library covers every download
     * waiting for it, and each is then linked to its song.
     */
    const indexer = Effect.gen(function* () {
      const waiting = yield* orUnavailable(
        db.select().from(youtubeDownloads).where(eq(youtubeDownloads.state, 'indexing')),
      );
      if (!waiting.length) {
        yield* Queue.take(indexWakeups).pipe(Effect.timeoutOption(IDLE_POLL_INTERVAL));
        return;
      }
      const target = yield* ensureLibrary;
      // Only one scan runs at a time; a scan of every root may be running already.
      const scanId = yield* scans.start(target.rootId).pipe(
        Effect.retry({
          schedule: Schedule.spaced('5 seconds'),
          while: (error) => error._tag === 'ScanAlreadyRunning',
        }),
      );
      yield* awaitScan(scanId);
      const paths = waiting.flatMap((download) => (download.relativePath ? [download.relativePath] : []));
      const songs = paths.length
        ? yield* orUnavailable(
            db
              .select({ id: mediaEntries.id, relativePath: mediaEntries.relativePath })
              .from(mediaEntries)
              .where(
                and(
                  eq(mediaEntries.mediaRootId, target.rootId),
                  inArray(mediaEntries.relativePath, paths),
                  isNull(mediaEntries.deletedAt),
                ),
              ),
          )
        : [];
      const songByPath = new Map(songs.map((song) => [song.relativePath, song.id]));
      // A download dismissed while the scan ran has no row left to update.
      for (const download of waiting)
        yield* update(download.id, {
          state: 'completed',
          mediaEntryId: download.relativePath ? (songByPath.get(download.relativePath) ?? null) : null,
          completedAt: new Date(),
        });
      yield* Effect.logInfo('YouTube downloads added to the library').pipe(
        Effect.annotateLogs({ downloads: waiting.length, scanId }),
      );
    });

    /** Runs `loop` for as long as the service lives; failures are logged and the loop goes on. */
    const keepRunning = <E>(name: string, loop: Effect.Effect<void, E>) =>
      loop.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(`The YouTube ${name} failed; trying again shortly`, Cause.pretty(cause)).pipe(
                Effect.andThen(Effect.sleep('30 seconds')),
              ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );

    yield* Effect.gen(function* () {
      yield* ensureLibrary.pipe(
        Effect.tapError((error) =>
          Effect.logWarning('The YouTube library is unavailable; retrying every minute', error.cause),
        ),
        Effect.retry(Schedule.spaced('1 minute')),
      );
      // This process is the only one (one app instance per database): unfinished downloads were
      // interrupted by a restart, so they start over.
      yield* orUnavailable(
        db
          .update(youtubeDownloads)
          .set({ state: 'queued', updatedAt: sql`now()` })
          .where(eq(youtubeDownloads.state, 'downloading')),
      ).pipe(Effect.retry(Schedule.spaced('30 seconds')));
      yield* keepRunning('downloader', downloader);
      yield* keepRunning('indexer', indexer);
    }).pipe(Effect.forkScoped);

    const wake = Queue.offer(downloadWakeups, undefined).pipe(Effect.asVoid);

    /** Queues a video's audio for download. */
    const start = (
      url: string,
    ): Effect.Effect<
      YouTubeDownloadId,
      InvalidYouTubeUrl | YouTubeDownloadActive | YouTubeLibraryUnavailable | DatabaseUnavailable
    > =>
      Effect.gen(function* () {
        const videoId = youtubeVideoId(url);
        if (!videoId) return yield* new InvalidYouTubeUrl({ url });
        yield* ensureLibrary;
        const id = YouTubeDownloadId.make(randomUUID());
        yield* orUnavailable(
          db
            .insert(youtubeDownloads)
            .values({ id, videoId, url: youtubeWatchUrl(videoId), state: 'queued' })
            .pipe(
              Effect.catchIf(
                (error) => uniqueViolation(error) === 'youtube_download_single_active',
                () => Effect.fail(new YouTubeDownloadActive({ videoId })),
              ),
            ),
        );
        yield* wake;
        yield* Effect.logInfo('YouTube download queued').pipe(Effect.annotateLogs({ downloadId: id, videoId }));
        return id;
      });

    /** Queues a failed download again. Its partial file, if any, is resumed. */
    const retry = (
      id: YouTubeDownloadId,
    ): Effect.Effect<
      void,
      YouTubeDownloadNotFound | YouTubeDownloadNotFailed | YouTubeDownloadActive | DatabaseUnavailable
    > =>
      Effect.gen(function* () {
        const [download] = yield* orUnavailable(
          db.select().from(youtubeDownloads).where(eq(youtubeDownloads.id, id)).limit(1),
        );
        if (!download) return yield* new YouTubeDownloadNotFound({ id });
        if (download.state !== 'failed') return yield* new YouTubeDownloadNotFailed({ id });
        yield* orUnavailable(
          db
            .update(youtubeDownloads)
            .set({ state: 'queued', errorMessage: null, updatedAt: sql`now()` })
            .where(and(eq(youtubeDownloads.id, id), eq(youtubeDownloads.state, 'failed')))
            .pipe(
              Effect.catchIf(
                (error) => uniqueViolation(error) === 'youtube_download_single_active',
                () => Effect.fail(new YouTubeDownloadActive({ videoId: download.videoId })),
              ),
            ),
        );
        yield* wake;
      });

    /**
     * Removes a download from the list, stopping it if it is running. A saved song stays in the
     * library; a partial file is deleted.
     */
    const dismiss = (id: YouTubeDownloadId): Effect.Effect<void, YouTubeDownloadNotFound | DatabaseUnavailable> =>
      Effect.gen(function* () {
        const running = current;
        if (running?.id === id) yield* Fiber.interrupt(running.fiber);
        const deleted = yield* orUnavailable(
          db.delete(youtubeDownloads).where(eq(youtubeDownloads.id, id)).returning({ id: youtubeDownloads.id }),
        );
        if (!deleted.length) return yield* new YouTubeDownloadNotFound({ id });
        yield* removeStaging(id);
      });

    return { start, retry, dismiss } as const;
  }),
}) {
  /** Requires `Database`, `FernConfig`, `MediaProcessRunner`, `MediaRootRepository`, and `Scans`. */
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  /** Requires `Database`, `FernConfig`, and `ScanEvents`. */
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(Scans.layer),
    Layer.provide(MediaRootRepository.layer),
    Layer.provide(MediaProcessRunner.layer),
  );
}
