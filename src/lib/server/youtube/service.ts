import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  Cause,
  Context,
  DateTime,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FileSystem,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Stream,
  SynchronizedRef,
} from 'effect';
import { FernConfig } from '$lib/server/config';
import { mediaEntries, youtubeDownloads } from '$lib/server/db/schema';
import { Database, orUnavailable, uniqueViolation, type DatabaseUnavailable } from '$lib/server/db/service';
import { MediaProcess, type ProcessError } from '$lib/server/media/process';
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
  YouTubeSavedFileRejected,
} from './errors';
import { describeYtDlpFailure, libraryRelativePath, parseYtDlpLine, ytDlpArgs, type YtDlpEvent } from './yt-dlp';

type Download = typeof youtubeDownloads.$inferSelect;
type Library = { readonly path: string; readonly rootId: MediaRootId };

/** What yt-dlp has reported about a download so far. */
type Report = {
  readonly info: { title: string | null; channel: string | null; durationMs: number | null } | null;
  readonly downloadedBytes: number | null;
  readonly totalBytes: number | null;
  readonly savedPath: string | null;
  /** Whether anything changed since progress was last written. */
  readonly changed: boolean;
};

/** Partial downloads, inside the library but hidden from scans like every dot-folder. */
const STAGING_DIRECTORY = '.downloading';
/** A download that takes longer is stopped. Long mixes at a slow connection still fit. */
const DOWNLOAD_TIMEOUT = '4 hours';
/** Progress is written at most this often; Zero carries it to the page. */
const PROGRESS_INTERVAL = '1 second';
/** How often a download waiting to be indexed checks whether its scan has finished. */
const SCAN_POLL_INTERVAL = '2 seconds';
/** How long the indexer waits after a failed scan before it scans again. */
const INDEX_RETRY_INTERVAL = '30 seconds';
/** Downloads are announced by `wake`; this is only a fallback. */
const IDLE_POLL_INTERVAL = '1 minute';

/**
 * Saves the audio of YouTube videos into the YouTube library: a music root of Fern's own at
 * `DOWNLOADS_DIR`, created on startup, which users cannot remove. One video downloads at a time;
 * each saved file is then indexed by a scan of that root, which also reads the video's chapters
 * from the file. Progress lives in `youtube_downloads`, which Zero synchronizes to the page.
 *
 * Downloads a previous process left unfinished start again on startup, and yt-dlp resumes their
 * partial files.
 */
export interface Interface {
  /** Queues a video's audio for download. */
  readonly start: (
    url: string,
  ) => Effect.Effect<
    YouTubeDownloadId,
    InvalidYouTubeUrl | YouTubeDownloadActive | YouTubeLibraryUnavailable | DatabaseUnavailable
  >;
  /** Queues a failed download again. Its partial file, if any, is resumed. */
  readonly retry: (
    id: YouTubeDownloadId,
  ) => Effect.Effect<
    void,
    YouTubeDownloadNotFound | YouTubeDownloadNotFailed | YouTubeDownloadActive | DatabaseUnavailable
  >;
  /**
   * Removes a download from the list, stopping it if it is running. A saved song stays in the
   * library; a partial file is deleted.
   */
  readonly dismiss: (id: YouTubeDownloadId) => Effect.Effect<void, YouTubeDownloadNotFound | DatabaseUnavailable>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/YouTubeDownloads') {}

/**
 * Requires `Database`, `FernConfig`, `FileSystem`, `MediaProcess`, `MediaRootRepository`, and
 * `Scans`. Starts the downloader and the indexer, which run until the layer is released.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* Database.Service;
    const config = yield* FernConfig.Service;
    const fs = yield* FileSystem.FileSystem;
    const media = yield* MediaProcess.Service;
    const repository = yield* MediaRootRepository.Service;
    const scans = yield* Scans.Service;
    // The running download, keyed by its ID so dismissing it can stop it.
    const running = yield* FiberMap.make<string>();
    const downloadWakeups = yield* Queue.sliding<void>(1);
    const indexWakeups = yield* Queue.sliding<void>(1);
    const libraryRef = yield* SynchronizedRef.make(Option.none<Library>());

    const ffmpegLocation = /[\\/]/.test(config.FFMPEG_PATH) ? path.resolve(config.FFMPEG_PATH) : null;

    /** Updates a download and returns its row, or nothing when it was dismissed in the meantime. */
    const update = (id: string, fields: Partial<typeof youtubeDownloads.$inferInsert>) =>
      orUnavailable(
        db
          .update(youtubeDownloads)
          .set({ ...fields, updatedAt: sql`now()` })
          .where(eq(youtubeDownloads.id, id))
          .returning({ id: youtubeDownloads.id }),
      );

    /**
     * The library's folder and root, created the first time they are needed. Callers wait for one
     * another, and a failure is not remembered, so the next caller tries again.
     */
    const ensureLibrary = SynchronizedRef.modifyEffect(libraryRef, (current) => {
      if (Option.isSome(current)) return Effect.succeed([current.value, current] as const);
      return Effect.gen(function* () {
        yield* fs.makeDirectory(config.DOWNLOADS_DIR, { recursive: true });
        const directory = yield* fs.realPath(config.DOWNLOADS_DIR);
        const library = { path: directory, rootId: yield* repository.ensureYouTubeRoot(directory) };
        yield* Effect.logInfo('YouTube library ready').pipe(Effect.annotateLogs(library));
        return [library, Option.some(library)] as const;
      }).pipe(Effect.mapError((cause) => new YouTubeLibraryUnavailable({ cause })));
    });

    const stagingPath = (libraryPath: string, id: string) => path.join(libraryPath, STAGING_DIRECTORY, id);

    const removeStaging = Effect.fnUntraced(function* (id: string) {
      const library = yield* SynchronizedRef.get(libraryRef);
      if (Option.isNone(library)) return;
      yield* fs.remove(stagingPath(library.value.path, id), { recursive: true, force: true }).pipe(Effect.ignore);
    });

    /** Runs yt-dlp for one download and records what it reports. Returns the saved file's library path. */
    const fetchAudio = Effect.fnUntraced(function* (download: Download, target: Library) {
      const report = yield* Ref.make<Report>({
        info: null,
        downloadedBytes: null,
        totalBytes: null,
        savedPath: null,
        changed: false,
      });
      const flush = Ref.modify(report, (current) => [current, { ...current, changed: false }] as const).pipe(
        Effect.flatMap((current) =>
          current.changed
            ? update(download.id, {
                ...(current.info ?? {}),
                downloadedBytes: current.downloadedBytes,
                totalBytes: current.totalBytes,
              })
            : Effect.void,
        ),
        // Progress is only for show; a missed update is replaced by the next one.
        Effect.catchTag('DatabaseUnavailable', () => Effect.void),
      );

      yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(PROGRESS_INTERVAL), flush)));
      yield* media
        .lines({
          program: 'yt-dlp',
          args: ytDlpArgs({
            url: download.url,
            libraryPath: target.path,
            stagingPath: stagingPath(target.path, download.id),
            nodePath: process.execPath,
            ffmpegLocation,
          }),
          timeout: DOWNLOAD_TIMEOUT,
        })
        .pipe(
          Stream.map(parseYtDlpLine),
          Stream.runForEach((event) => (event ? Ref.update(report, (current) => record(current, event)) : Effect.void)),
        );
      yield* flush;
      const savedPath = (yield* Ref.get(report)).savedPath;
      const relativePath = savedPath === null ? null : libraryRelativePath(target.path, savedPath);
      return relativePath ?? (yield* new YouTubeSavedFileRejected({ path: savedPath }));
    }, Effect.scoped);

    /**
     * Downloads one video, then hands it to the indexer. Interruption leaves the row for a later
     * process. A download dismissed while it runs has no row left to update: the staging folder is
     * removed and the saved file, if yt-dlp got that far, stays in the library like any song.
     */
    const runDownload = Effect.fn('YouTubeDownloads.download')(
      function* (download: Download) {
        // `dismiss` deletes the row before it stops the fiber, so a dismissal that missed this fiber
        // (it was not registered yet) has already deleted the row.
        const listed = yield* orUnavailable(
          db.select({ id: youtubeDownloads.id }).from(youtubeDownloads).where(eq(youtubeDownloads.id, download.id)),
        );
        if (!listed.length) return yield* removeStaging(download.id);
        yield* Effect.logInfo('YouTube download started');
        const outcome = yield* Effect.exit(Effect.flatMap(ensureLibrary, (target) => fetchAudio(download, target)));
        if (Exit.isSuccess(outcome)) {
          const updated = yield* update(download.id, { state: 'indexing', relativePath: outcome.value });
          yield* removeStaging(download.id);
          if (!updated.length) return yield* Effect.logInfo('YouTube download dismissed while it ran');
          yield* Queue.offer(indexWakeups, undefined);
          yield* Effect.logInfo('YouTube download saved').pipe(Effect.annotateLogs({ file: outcome.value }));
          return;
        }
        if (Cause.hasInterruptsOnly(outcome.cause)) return yield* Effect.interrupt;
        const error = Cause.findErrorOption(outcome.cause);
        const message = Option.isNone(error) ? 'The download stopped unexpectedly.' : describeFailure(error.value);
        yield* Effect.logWarning('YouTube download failed', Cause.pretty(outcome.cause));
        const updated = yield* update(download.id, { state: 'failed', errorMessage: message });
        if (!updated.length) yield* removeStaging(download.id);
      },
      (effect, download) =>
        effect.pipe(
          Effect.catchTag('DatabaseUnavailable', (error) =>
            Effect.logWarning('Could not record a YouTube download; it runs again after a restart', error.cause),
          ),
          Effect.annotateLogs({ downloadId: download.id, videoId: download.videoId }),
        ),
    );

    /** Takes the oldest queued download, or null when none is waiting. */
    const claimNext: Effect.Effect<Download | null, DatabaseUnavailable> = Effect.gen(function* () {
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
      // Dismissed after it was read: look at the queue again.
      return claimed ?? (yield* claimNext);
    });

    /** Downloads queued videos one at a time, in the order they were added. */
    const downloader = Effect.gen(function* () {
      const download = yield* claimNext;
      if (!download) {
        yield* Queue.take(downloadWakeups).pipe(Effect.timeoutOption(IDLE_POLL_INTERVAL));
        return;
      }
      // `dismiss` interrupts the fiber through this map, so it must be registered before it starts.
      const fiber = yield* FiberMap.run(running, download.id, runDownload(download), { startImmediately: false });
      yield* Fiber.await(fiber);
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
      const scan = yield* awaitScan(scanId);
      if (scan.state !== 'completed') {
        // The downloads stay `indexing`, so the next pass scans again once this wait is over.
        yield* Effect.logWarning('Scanning the YouTube library failed; trying again shortly').pipe(
          Effect.annotateLogs({ scanId, scanState: scan.state }),
        );
        return yield* Effect.sleep(INDEX_RETRY_INTERVAL);
      }
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
      const completedAt = yield* DateTime.nowAsDate;
      let missing = 0;
      // A download dismissed while the scan ran has no row left to update.
      for (const download of waiting) {
        const mediaEntryId = download.relativePath ? songByPath.get(download.relativePath) : undefined;
        if (mediaEntryId) {
          yield* update(download.id, { state: 'completed', mediaEntryId, completedAt });
          continue;
        }
        // The scan finished without the file, so it will not appear by waiting; retrying downloads it again.
        missing++;
        yield* Effect.logWarning('A saved YouTube download is not in the library').pipe(
          Effect.annotateLogs({ downloadId: download.id, file: download.relativePath }),
        );
        yield* update(download.id, {
          state: 'failed',
          errorMessage: 'The video was saved, but the library scan did not add it. Try the download again.',
        });
      }
      yield* Effect.logInfo('YouTube downloads added to the library').pipe(
        Effect.annotateLogs({ downloads: waiting.length - missing, missing, scanId }),
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

    const start = Effect.fn('YouTubeDownloads.start')(function* (url: string) {
      const videoId = youtubeVideoId(url);
      if (!videoId) return yield* new InvalidYouTubeUrl({ url });
      yield* ensureLibrary;
      const id = YouTubeDownloadId.make(randomUUID());
      yield* db
        .insert(youtubeDownloads)
        .values({ id, videoId, url: youtubeWatchUrl(videoId), state: 'queued' })
        .pipe(
          Effect.catchIf(
            (error) => uniqueViolation(error) === 'youtube_download_single_active',
            () => Effect.fail(new YouTubeDownloadActive({ videoId })),
          ),
          orUnavailable,
        );
      yield* wake;
      yield* Effect.logInfo('YouTube download queued').pipe(Effect.annotateLogs({ downloadId: id, videoId }));
      return id;
    });

    const retry = Effect.fn('YouTubeDownloads.retry')(function* (id: YouTubeDownloadId) {
      const [download] = yield* orUnavailable(
        db.select().from(youtubeDownloads).where(eq(youtubeDownloads.id, id)).limit(1),
      );
      if (!download) return yield* new YouTubeDownloadNotFound({ id });
      if (download.state !== 'failed') return yield* new YouTubeDownloadNotFailed({ id });
      yield* db
        .update(youtubeDownloads)
        .set({ state: 'queued', errorMessage: null, updatedAt: sql`now()` })
        .where(and(eq(youtubeDownloads.id, id), eq(youtubeDownloads.state, 'failed')))
        .pipe(
          Effect.catchIf(
            (error) => uniqueViolation(error) === 'youtube_download_single_active',
            () => Effect.fail(new YouTubeDownloadActive({ videoId: download.videoId })),
          ),
          orUnavailable,
        );
      yield* wake;
    });

    // The row goes first: a download without a row is never started or recorded (see `runDownload`),
    // so a dismissal cut short after the delete leaves nothing stuck. The steps after it are
    // uninterruptible so yt-dlp is stopped before its partial files are removed.
    const dismiss = Effect.fn('YouTubeDownloads.dismiss')(function* (id: YouTubeDownloadId) {
      const deleted = yield* orUnavailable(
        db.delete(youtubeDownloads).where(eq(youtubeDownloads.id, id)).returning({ id: youtubeDownloads.id }),
      );
      if (!deleted.length) return yield* new YouTubeDownloadNotFound({ id });
      yield* Effect.uninterruptible(Effect.andThen(FiberMap.remove(running, id), removeStaging(id)));
    });

    return Service.of({ start, retry, dismiss });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(Scans.defaultLayer),
  Layer.provide(MediaRootRepository.defaultLayer),
  Layer.provide(MediaProcess.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(FernConfig.defaultLayer),
  Layer.provide(NodeServices.layer),
);

function record(report: Report, event: YtDlpEvent): Report {
  if (event.type === 'info')
    return {
      ...report,
      info: { title: event.title, channel: event.channel, durationMs: event.durationMs },
      changed: true,
    };
  if (event.type === 'progress')
    return { ...report, downloadedBytes: event.downloadedBytes, totalBytes: event.totalBytes, changed: true };
  return { ...report, savedPath: event.path, changed: true };
}

function describeFailure(error: ProcessError | YouTubeLibraryUnavailable | YouTubeSavedFileRejected) {
  switch (error._tag) {
    case 'YouTubeLibraryUnavailable':
      return 'The YouTube library is unavailable. Fern’s log has the details.';
    case 'YouTubeSavedFileRejected':
      return 'The video was downloaded, but Fern could not use the file yt-dlp saved.';
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

export * as YouTubeDownloads from './service';
