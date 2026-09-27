import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Cause, Clock, Context, Data, Duration, Effect, Exit, Layer, Option, Queue } from 'effect';
import { Database, type DatabaseUnavailable } from '$lib/server/db/service';
import type { ScanId } from '$lib/shared/contracts/ids';
import { ScanEvents } from './events';
import {
  claimNextJob,
  completeJob,
  deleteFinishedJobs,
  failJob,
  findExpiredLeases,
  releaseJob,
  renewLease,
  retryJob,
  type Lease,
  type ScanJobRow,
} from './job-store';
import { ScanQueuePolicy, retryDelayMs } from './jobs';
import { tryLeadership, type Leadership } from './leadership';
import { Scanner } from './scanner';

/** The worker's lease expired while the scan ran, so another worker may own the job now. */
class LeaseLost extends Data.TaggedError('LeaseLost')<{ readonly scanId: string }> {}

/** Public summaries stored on a scan. Details go to the log and to `scan_jobs.last_error`. */
const summaries = {
  database: 'The library database became unavailable.',
  defect: 'The scan stopped unexpectedly.',
  crashed: 'The scan worker stopped before the scan finished.',
} as const;

const MAX_ERROR_LENGTH = 4000;

type ScanWorkerStatus = {
  readonly workerId: string;
  /** Whether this process holds the scan worker lock. */
  readonly leader: boolean;
  readonly currentScanId: string | null;
};

/**
 * Runs accepted scans from the `scan_jobs` lease table. One process at a time is the worker: it
 * holds a PostgreSQL advisory lock on a dedicated connection. The worker leases a due job, renews
 * the lease while the scan runs, and settles the job and the scan together when the attempt ends.
 *
 * - Failed attempts are retried with bounded exponential backoff, up to the policy's attempts.
 * - A graceful shutdown hands the job back without using up an attempt.
 * - A crashed worker's lease expires, and the next worker retries the scan.
 * - Redelivering a scan that already finished completes the job without scanning again.
 */
export class ScanWorker extends Context.Service<ScanWorker>()('fern/ScanWorker', {
  make: Effect.gen(function* () {
    const db = yield* Database;
    const scanner = yield* Scanner;
    const events = yield* ScanEvents;
    const policy = yield* ScanQueuePolicy;
    const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    const lockExpirationMs = Duration.toMillis(policy.lockExpiration);
    const cleanupIntervalMs = Duration.toMillis(policy.cleanupInterval);
    const wakeups = yield* Queue.sliding<void>(1);
    const maintenanceIntervalMs = Duration.toMillis(policy.maintenanceInterval);
    const state = {
      leader: false,
      currentScanId: null as string | null,
      lastCleanupMs: -Infinity,
      lastMaintenanceMs: -Infinity,
    };

    const waitForWork = (interval: Duration.Input) =>
      Queue.take(wakeups).pipe(Effect.timeoutOption(interval), Effect.asVoid);

    /** Retries the attempt if attempts remain; otherwise fails the job and the scan. */
    const settleFailure = (lease: Lease, job: ScanJobRow, summary: string, error: string) =>
      Effect.gen(function* () {
        const scanId = lease.scanId as ScanId;
        const detail = error.slice(0, MAX_ERROR_LENGTH);
        if (job.attempts < job.maxAttempts) {
          const delayMs = retryDelayMs(job.attempts, policy);
          const message = `${summary} Retrying (attempt ${job.attempts + 1} of ${job.maxAttempts}).`;
          if (!(yield* retryJob(db, lease, { delayMs, error: detail, summary: message }))) return;
          yield* Effect.logWarning('Scan attempt failed; retrying').pipe(
            Effect.annotateLogs({ attempt: job.attempts, maxAttempts: job.maxAttempts, retryDelayMs: delayMs }),
          );
          yield* events.publish(scanId, {
            type: 'scan.retrying',
            data: { state: 'retrying', message, attempts: job.attempts },
          });
          return;
        }
        if (!(yield* failJob(db, lease, { error: detail, summary }))) return;
        yield* Effect.logError('Scan failed on its final attempt', detail).pipe(
          Effect.annotateLogs({ attempt: job.attempts, maxAttempts: job.maxAttempts }),
        );
        yield* events.publish(scanId, { type: 'scan.failed', data: { state: 'failed', message: summary } });
      });

    /** Records how an attempt ended. Runs even when the attempt was interrupted. */
    const settle = (lease: Lease, job: ScanJobRow, exit: Exit.Exit<void, LeaseLost | DatabaseUnavailable>) =>
      Effect.gen(function* () {
        if (Exit.isSuccess(exit)) {
          if (yield* completeJob(db, lease)) yield* Effect.logInfo('Scan attempt finished');
          else
            yield* Effect.logWarning(
              'Scan finished after its lease expired; redelivery completes the job without scanning again',
            );
          return;
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          if (yield* releaseJob(db, lease)) yield* Effect.logInfo('Scan handed back for redelivery after interruption');
          return;
        }
        const error = Cause.findErrorOption(exit.cause);
        if (Option.isSome(error) && error.value._tag === 'LeaseLost') {
          yield* Effect.logWarning('Scan lease expired while the scan ran; it will be redelivered');
          return;
        }
        const summary = Option.isSome(error) ? summaries.database : summaries.defect;
        yield* settleFailure(lease, job, summary, Cause.pretty(exit.cause));
      }).pipe(
        // The lease expires on its own, and the next worker retries the scan.
        Effect.catchTag('DatabaseUnavailable', (error) =>
          Effect.logWarning(
            'Could not record the scan attempt; it will be retried when its lease expires',
            error.cause,
          ),
        ),
      );

    /** Renews the lease until the attempt ends. Fails only if the lease is gone. */
    const renewals = (lease: Lease): Effect.Effect<never, LeaseLost> =>
      Effect.gen(function* () {
        yield* Effect.sleep(policy.lockRefreshInterval);
        const held = yield* renewLease(db, lease, lockExpirationMs).pipe(
          // A brief database outage does not end the attempt; the next renewal tries again.
          Effect.catchTag('DatabaseUnavailable', () => Effect.succeed(true)),
        );
        if (!held) return yield* new LeaseLost({ scanId: lease.scanId });
      }).pipe(Effect.forever);

    const runJob = (job: ScanJobRow) => {
      const lease: Lease = { scanId: job.scanRunId, lockedBy: workerId };
      return Effect.gen(function* () {
        yield* Effect.logInfo('Scan attempt started');
        state.currentScanId = job.scanRunId;
        yield* scanner.run(job.scanRunId as ScanId).pipe(
          Effect.raceFirst(renewals(lease)),
          Effect.onExit((exit) => settle(lease, job, exit)),
          Effect.ensuring(Effect.sync(() => (state.currentScanId = null))),
          // Failures were settled above; only interruption continues.
          Effect.ignore,
        );
      }).pipe(
        Effect.annotateLogs({ scanId: job.scanRunId, attempt: job.attempts }),
        Effect.withSpan('scan.job', { attributes: { scanId: job.scanRunId, attempt: job.attempts } }),
      );
    };

    /**
     * Recovers crashed workers' jobs and removes old jobs. Runs when
     * this process becomes the worker and then every `maintenanceInterval`, not on every poll.
     */
    const maintain = Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      if (started - state.lastMaintenanceMs < maintenanceIntervalMs) return;
      state.lastMaintenanceMs = started;
      for (const job of yield* findExpiredLeases(db)) {
        const lease: Lease = { scanId: job.scanRunId, lockedBy: job.lockedBy ?? '', expired: true };
        yield* settleFailure(lease, job, summaries.crashed, `Lease held by ${job.lockedBy} expired.`).pipe(
          Effect.annotateLogs({ scanId: job.scanRunId, previousWorker: job.lockedBy }),
        );
      }
      if (started - state.lastCleanupMs >= cleanupIntervalMs) {
        state.lastCleanupMs = started;
        const removed = yield* deleteFinishedJobs(db, {
          completedMs: Duration.toMillis(policy.completedRetention),
          failedMs: Duration.toMillis(policy.failedRetention),
        });
        if (removed) yield* Effect.logDebug('Removed finished scan jobs').pipe(Effect.annotateLogs({ removed }));
      }
    });

    const consume = (leadership: Leadership) =>
      Effect.gen(function* () {
        yield* leadership.check;
        yield* maintain;
        const job = yield* claimNextJob(db, workerId, lockExpirationMs);
        if (job) yield* runJob(job);
        else yield* waitForWork(policy.pollInterval);
      }).pipe(Effect.forever);

    /** One term as the worker: take the lock and consume jobs until the lock's connection fails. */
    const term = Effect.scoped(
      Effect.gen(function* () {
        const leadership = yield* tryLeadership(db.$client);
        if (Option.isNone(leadership)) return;
        state.leader = true;
        state.lastMaintenanceMs = -Infinity;
        yield* Effect.logInfo('This process is now the scan worker');
        yield* consume(leadership.value);
      }).pipe(Effect.ensuring(Effect.sync(() => (state.leader = false)))),
    );

    yield* term.pipe(
      Effect.catchTag('DatabaseUnavailable', (error) =>
        Effect.logWarning('The scan worker cannot reach the database', error.cause),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError('The scan worker stopped unexpectedly', Cause.pretty(cause)),
      ),
      Effect.andThen(waitForWork(policy.leadershipRetryInterval)),
      Effect.forever,
      Effect.annotateLogs({ workerId }),
      Effect.forkScoped,
    );

    /** Looks for work now instead of at the next poll. Only the process holding the lock acts on it. */
    const wake = Queue.offer(wakeups, undefined).pipe(Effect.asVoid);

    const status = Effect.sync((): ScanWorkerStatus => ({
      workerId,
      leader: state.leader,
      currentScanId: state.currentScanId,
    }));

    return { wake, status } as const;
  }),
}) {
  /** Requires `Database`, `Scanner`, and `ScanEvents`. */
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  /** Requires `Database`, `FernConfig`, and `ScanEvents`. */
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(Scanner.layer));
}
