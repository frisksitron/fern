import path from 'node:path';
import { Clock, Context, Effect, Layer } from 'effect';
import { FernConfig } from '$lib/server/config';
import type { mediaRoots } from '$lib/server/db/schema';
import { Database, type DatabaseUnavailable } from '$lib/server/db/service';
import { MediaProbe, type ProbeFailed, type ProbeResult } from '$lib/server/media/probe';
import { Disk, type FileSystemError } from '$lib/server/platform/disk';
import type { MediaRootId, ScanId } from '$lib/shared/contracts/ids';
import type { ScanCounts, ScanState } from '$lib/shared/contracts/scans';
import { ScanEvents } from './events';
import {
  clearScanErrors,
  loadActiveSubtitles,
  loadExistingEntries,
  loadRoots,
  loadScan,
  markRootScanned,
  recordScanErrors,
  softDeleteEntries,
  softDeleteSubtitles,
  transitionScan,
  updateArtwork,
  upsertEntries,
  upsertSubtitles,
  writeProbeOutcomes,
  writeProgress,
  type ProbeOutcome,
} from './persistence';
import { planArtwork, planEntries, planSubtitleRemovals, planSubtitles, type PlannedEntry } from './plan';
import { isTerminalScanState } from './state';
import { traverseRoot, type RootUnavailable } from './traversal';

type MediaRoot = typeof mediaRoots.$inferSelect;

/** Running totals for one scan, updated in place as roots are scanned. */
type Counts = { -readonly [Key in keyof ScanCounts]: ScanCounts[Key] };

type RawProbeOutcome =
  | { readonly id: string; readonly relativePath: string; readonly result: ProbeResult }
  | { readonly id: string; readonly relativePath: string; readonly failure: ProbeFailed };

/** Progress is persisted and published at most this often, however fast files are found. */
const PROGRESS_INTERVAL_MS = 500;
/** Probe results are written in batches of this many files. */
const PROBE_BATCH_SIZE = 32;

/** Measurements for one root, logged when it finishes. */
type RootScanStats = {
  readonly entriesFound: number;
  readonly entriesWritten: number;
  readonly entriesRemoved: number;
  readonly writeStatements: number;
  readonly probed: number;
  readonly probeFailures: number;
  readonly unreadablePaths: number;
  readonly durationMs: number;
};

function describeFileSystemError(error: FileSystemError | 'not-a-directory') {
  if (error === 'not-a-directory') return 'Not a directory';
  if (error._tag === 'PathNotFound') return 'Not found';
  if (error._tag === 'PathAccessDenied') return 'Permission denied';
  return `Unavailable: ${String(error.cause)}`;
}

function describeProbeFailure(error: ProbeFailed) {
  const cause = error.cause;
  switch (cause._tag) {
    case 'ProcessExited':
      return (cause.stderr || `ffprobe exited with code ${cause.code}`).slice(0, 2000);
    case 'ProcessTimedOut':
      return `ffprobe timed out after ${cause.timeoutMs} ms`;
    case 'ProcessOutputTooLarge':
      return `ffprobe printed more than ${cause.limitBytes} bytes`;
    case 'ProcessSpawnFailed':
      return 'ffprobe could not be started';
    case 'SchemaError':
      return `ffprobe returned unexpected output: ${cause.message}`.slice(0, 2000);
  }
}

const zeroCounts = (): Counts => ({
  directoriesSeen: 0,
  filesSeen: 0,
  videosSeen: 0,
  audioSeen: 0,
  filesProbed: 0,
  errorsCount: 0,
});

/**
 * Executes scans. Running the same scan ID again is safe: entries are matched by path, only changes
 * are written, tracks are replaced, and the scan's error list starts afresh.
 */
export interface Interface {
  /**
   * Runs a scan to completion. Rerunning a scan repeats its work safely, and a scan that already
   * finished is left alone, so redelivering a scan is harmless. Database failures end the run; the
   * scan worker decides whether to retry.
   */
  readonly run: (scanId: ScanId) => Effect.Effect<void, DatabaseUnavailable>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/Scanner') {}

/** Requires `Database`, `FernConfig`, `Disk`, `MediaProbe`, and `ScanEvents`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* Database.Service;
    const events = yield* ScanEvents.Service;
    const config = yield* FernConfig.Service;
    const disk = yield* Disk.Service;
    const prober = yield* MediaProbe.Service;

    /** Persists and publishes progress, throttled to PROGRESS_INTERVAL_MS. */
    const progressReporter = (scanId: ScanId, counts: Counts) => {
      let lastWrite = Number.NEGATIVE_INFINITY;
      return Effect.fnUntraced(function* (rootId: string, currentPath: string, force = false) {
        const now = yield* Clock.currentTimeMillis;
        if (!force && now - lastWrite < PROGRESS_INTERVAL_MS) return;
        lastWrite = now;
        const snapshot = { ...counts };
        yield* writeProgress(db, scanId, { ...snapshot, currentRootId: rootId, currentPath });
        yield* events.publish(scanId, {
          type: 'scan.progress',
          data: { state: 'running', rootId: rootId as MediaRootId, currentDisplayPath: currentPath, ...snapshot },
        });
      });
    };

    type Report = ReturnType<typeof progressReporter>;

    /** Probes pending media with bounded concurrency, writing each batch in one transaction. */
    const probePending = Effect.fnUntraced(function* (
      scanId: ScanId,
      root: MediaRoot,
      pending: readonly PlannedEntry[],
      counts: Counts,
      report: Report,
    ) {
      let probed = 0;
      let failures = 0;
      for (let index = 0; index < pending.length; index += PROBE_BATCH_SIZE) {
        const batch = pending.slice(index, index + PROBE_BATCH_SIZE);
        const outcomes = yield* Effect.forEach(
          batch,
          (entry) =>
            prober.probe(path.join(root.path, ...entry.relativePath.split('/'))).pipe(
              Effect.map((result): RawProbeOutcome => ({ id: entry.id, relativePath: entry.relativePath, result })),
              Effect.catchTag('ProbeFailed', (failure) =>
                Effect.succeed<RawProbeOutcome>({ id: entry.id, relativePath: entry.relativePath, failure }),
              ),
            ),
          { concurrency: config.SCAN_PROBE_CONCURRENCY },
        );
        // Without ffprobe nothing can be probed: leave the entries pending for a later scan.
        if (outcomes.some((outcome) => 'failure' in outcome && outcome.failure.cause._tag === 'ProcessSpawnFailed')) {
          counts.errorsCount++;
          yield* recordScanErrors(db, scanId, [
            {
              mediaRootId: root.id,
              relativePath: null,
              stage: 'probe',
              errorCode: 'FFPROBE_UNAVAILABLE',
              message: 'ffprobe could not be started; media stays pending until a later scan.',
            },
          ]);
          yield* Effect.logWarning('ffprobe is unavailable; skipped probing');
          break;
        }
        const stored = outcomes.map((outcome): ProbeOutcome =>
          'failure' in outcome
            ? { id: outcome.id, relativePath: outcome.relativePath, error: describeProbeFailure(outcome.failure) }
            : outcome,
        );
        yield* writeProbeOutcomes(db, scanId, root.id, stored);
        const batchFailures = stored.filter((outcome) => 'error' in outcome).length;
        failures += batchFailures;
        probed += stored.length - batchFailures;
        counts.filesProbed += stored.length - batchFailures;
        counts.errorsCount += batchFailures;
        yield* report(root.id, batch.at(-1)!.relativePath);
      }
      return { probed, failures };
    });

    const scanRoot = Effect.fn('Scanner.scanRoot')(
      function* (scanId: ScanId, root: MediaRoot, counts: Counts, report: Report) {
        yield* Effect.annotateCurrentSpan({ rootId: root.id });
        const started = yield* Clock.currentTimeMillis;
        const traversal = yield* traverseRoot(disk, root.path, (directory) => report(root.id, directory));
        const existing = yield* loadExistingEntries(db, root.id);
        const unreadablePaths = traversal.warnings.map((warning) => warning.relativePath);
        const plan = planEntries(
          root.mediaType === 'music' ? 'music' : 'video',
          traversal.items,
          existing,
          unreadablePaths,
        );

        for (const entry of plan.entries) {
          if (entry.kind === 'directory') counts.directoriesSeen++;
          else counts.filesSeen++;
          if (entry.isVideo) counts.videosSeen++;
          if (entry.isAudio) counts.audioSeen++;
        }

        const changed = plan.entries.filter((entry) => entry.changed);
        const writeStatements = yield* upsertEntries(db, root.id, scanId, changed);
        yield* report(root.id, '', true);

        const pending = plan.entries.filter((entry) => entry.probeStatus === 'pending');
        const probing = yield* probePending(scanId, root, pending, counts, report);

        const subtitles = planSubtitles(plan.entries);
        yield* upsertSubtitles(db, subtitles);
        if (root.mediaType === 'music')
          yield* updateArtwork(
            db,
            planArtwork(plan.entries, new Map(existing.map((entry) => [entry.id, entry.artworkMediaEntryId]))),
          );

        counts.errorsCount += traversal.warnings.length;
        yield* recordScanErrors(
          db,
          scanId,
          traversal.warnings.map((warning) => ({
            mediaRootId: root.id,
            relativePath: warning.relativePath,
            stage: 'walk' as const,
            errorCode: 'PATH_UNREADABLE',
            message: describeFileSystemError(warning.cause),
          })),
        );

        // Entries missing from the walk are removed, except those under a path that could not be
        // read: an unreadable folder, such as a network share that dropped mid-scan, must not make
        // its contents look deleted. The walk of the root itself succeeded, so the root counts as scanned.
        yield* softDeleteEntries(db, plan.removedIds);
        const staleSubtitles = planSubtitleRemovals(
          yield* loadActiveSubtitles(db, root.id),
          subtitles,
          unreadablePaths,
        );
        yield* softDeleteSubtitles(db, staleSubtitles);
        yield* markRootScanned(db, root.id);
        if (traversal.warnings.length > 0)
          yield* Effect.logWarning('Parts of the media root could not be read; kept their entries');

        const stats: RootScanStats = {
          entriesFound: plan.entries.length,
          entriesWritten: changed.length,
          entriesRemoved: plan.removedIds.length,
          writeStatements,
          probed: probing.probed,
          probeFailures: probing.failures,
          unreadablePaths: traversal.warnings.length,
          durationMs: (yield* Clock.currentTimeMillis) - started,
        };
        yield* Effect.logInfo('Scanned media root').pipe(Effect.annotateLogs(stats));
        return stats;
      },
      (effect, _scanId, root) => Effect.annotateLogs(effect, { rootId: root.id }),
    );

    /** Records a media root that could not be read; the scan goes on with the next one. */
    const recordUnavailableRoot = Effect.fnUntraced(function* (
      scanId: ScanId,
      root: MediaRoot,
      counts: Counts,
      error: RootUnavailable,
    ) {
      counts.errorsCount++;
      yield* recordScanErrors(db, scanId, [
        {
          mediaRootId: root.id,
          relativePath: null,
          stage: 'walk',
          errorCode: 'ROOT_UNAVAILABLE',
          message: describeFileSystemError(error.cause),
        },
      ]);
      yield* events.publish(scanId, {
        type: 'scan.warning',
        data: { rootId: root.id as MediaRootId, message: 'This media folder could not be read.' },
      });
      yield* Effect.logWarning('Media root unavailable').pipe(Effect.annotateLogs({ rootId: root.id }));
    });

    const run = Effect.fn('Scanner.run')(
      function* (scanId: ScanId) {
        yield* Effect.annotateCurrentSpan({ scanId });
        const scan = yield* loadScan(db, scanId);
        if (!scan || isTerminalScanState(scan.state as ScanState)) return;
        if (scan.state !== 'running')
          yield* transitionScan(db, scanId, 'running', { startedAt: scan.startedAt ?? new Date(), errorSummary: null });
        yield* clearScanErrors(db, scanId);
        yield* events.publish(scanId, { type: 'scan.started', data: { state: 'running' } });

        const counts = zeroCounts();
        const report = progressReporter(scanId, counts);
        for (const root of yield* loadRoots(db, scan.rootId)) {
          yield* scanRoot(scanId, root, counts, report).pipe(
            Effect.catchTag('RootUnavailable', (error) => recordUnavailableRoot(scanId, root, counts, error)),
          );
        }

        yield* transitionScan(db, scanId, 'completed', {
          completedAt: new Date(),
          currentPath: null,
          ...counts,
        });
        yield* events.publish(scanId, { type: 'scan.completed', data: { state: 'completed', ...counts } });
      },
      (effect, scanId) => Effect.annotateLogs(effect, { scanId }),
    );

    return Service.of({ run });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(ScanEvents.defaultLayer),
  Layer.provide(FernConfig.defaultLayer),
  Layer.provide(Disk.layer),
  Layer.provide(MediaProbe.defaultLayer),
);

export * as Scanner from './scanner';
