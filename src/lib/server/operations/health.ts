import { desc, eq, inArray, sql } from 'drizzle-orm';
import { Clock, Context, Duration, Effect, Exit, Layer, Option } from 'effect';
import { scanJobs, scanRuns } from '$lib/server/db/schema';
import { Database, orUnavailable } from '$lib/server/db/service';
import { MediaProcessRunner, type MediaProgram } from '$lib/server/media/process-runner';
import { explainScan } from '$lib/server/scans/diagnostics';
import type { ScanJobRow } from '$lib/server/scans/job-store';
import { SCAN_WORKER_LOCK } from '$lib/server/scans/leadership';
import { toScanRun } from '$lib/server/scans/service';
import { activeScanStates } from '$lib/server/scans/state';
import { ScanWorker } from '$lib/server/scans/worker';
import type { ReadinessResponse, ScanDiagnostics, ScanJobStatus } from '$lib/shared/contracts/health';

type CheckStatus = ReadinessResponse['checks']['database'];

/** Stored job errors can hold long stacks; diagnostics show the start. */
const MAX_ERROR_LENGTH = 2_000;
const RECENT_FAILURES = 5;

/** `ok` when `effect` succeeds within `timeout`; any failure, defect, or timeout is `unavailable`. */
function check(effect: Effect.Effect<unknown, unknown>, timeout: Duration.Input): Effect.Effect<CheckStatus> {
  return Effect.exit(Effect.timeoutOption(effect, timeout)).pipe(
    Effect.map((exit) => (Exit.isSuccess(exit) && Option.isSome(exit.value) ? 'ok' : 'unavailable')),
  );
}

function toJobStatus(row: ScanJobRow): ScanJobStatus {
  return {
    state: row.state as ScanJobStatus['state'],
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    availableAt: row.availableAt,
    lockedBy: row.lockedBy,
    lockedUntil: row.lockedUntil,
    lastError: row.lastError?.slice(0, MAX_ERROR_LENGTH) ?? null,
  };
}

/** Readiness checks and scan diagnostics for operators, read from Fern's own tables. */
export class Health extends Context.Service<Health>()('fern/Health', {
  make: Effect.gen(function* () {
    const db = yield* Database;
    const runner = yield* MediaProcessRunner;
    const worker = yield* ScanWorker;

    const executable = (program: MediaProgram) =>
      check(runner.run({ program, args: ['-version'], timeout: '5 seconds' }), '6 seconds');
    // Probes run often and starting processes is not free, so executables are checked once a minute.
    const executables = yield* Effect.cachedWithTTL(
      Effect.all({ ffmpeg: executable('ffmpeg'), ffprobe: executable('ffprobe') }, { concurrency: 2 }),
      '1 minute',
    );

    /** Whether this process can serve traffic: the database answers and FFmpeg and ffprobe run. */
    const readiness: Effect.Effect<ReadinessResponse> = Effect.gen(function* () {
      const [database, media] = yield* Effect.all(
        [check(orUnavailable(db.execute(sql`select 1`)), '2 seconds'), executables],
        { concurrency: 'unbounded' },
      );
      const checks = { database, ...media };
      const ready = Object.values(checks).every((status) => status === 'ok');
      if (!ready) yield* Effect.logWarning('Not ready').pipe(Effect.annotateLogs(checks));
      return { status: ready ? 'ready' : 'unavailable', checks };
    });

    /** The active scan and recent failures, each with its job and an explanation of its state. */
    const scanDiagnostics = Effect.gen(function* () {
      const lock = yield* orUnavailable(
        db.execute<{ held: boolean }>(
          sql`
          select exists (
            select 1 from pg_locks
            where locktype = 'advisory' and classid = 0 and objid = ${SCAN_WORKER_LOCK} and objsubid = 1 and granted
              and database = (select oid from pg_database where datname = current_database())
          ) as held`,
          'objects',
        ),
      );
      const workerLockHeld = Boolean(lock[0]?.held);
      const [active] = yield* orUnavailable(
        db
          .select()
          .from(scanRuns)
          .where(inArray(scanRuns.state, [...activeScanStates]))
          .orderBy(desc(scanRuns.requestedAt))
          .limit(1),
      );
      const failures = yield* orUnavailable(
        db
          .select()
          .from(scanRuns)
          .where(eq(scanRuns.state, 'failed'))
          .orderBy(desc(scanRuns.completedAt))
          .limit(RECENT_FAILURES),
      );
      const scanIds = [...(active ? [active.id] : []), ...failures.map((row) => row.id)];
      const jobs = scanIds.length
        ? yield* orUnavailable(db.select().from(scanJobs).where(inArray(scanJobs.scanRunId, scanIds)))
        : [];
      const jobByScan = new Map(jobs.map((job) => [job.scanRunId, toJobStatus(job)]));
      const now = new Date(yield* Clock.currentTimeMillis);
      const diagnose = (row: typeof scanRuns.$inferSelect) => {
        const scan = toScanRun(row);
        const job = jobByScan.get(row.id) ?? null;
        return { scan, job, explanation: explainScan(scan, job, now, workerLockHeld) };
      };
      return {
        workerLockHeld,
        worker: yield* worker.status,
        activeScan: active ? diagnose(active) : null,
        recentFailures: failures.map(diagnose),
      } satisfies ScanDiagnostics;
    });

    return { readiness, scanDiagnostics } as const;
  }),
}) {
  /** Requires `Database`, `MediaProcessRunner`, and `ScanWorker`. */
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  /** Requires `Database`, `FernConfig`, and `ScanEvents`. */
  static readonly layer = this.layerWithoutDependencies.pipe(
    Layer.provide(ScanWorker.layer),
    Layer.provide(MediaProcessRunner.layer),
  );
}
