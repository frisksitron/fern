import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Cause, Clock, Context, Duration, Effect, Exit, Layer, Option, Queue, Schema } from 'effect';
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
class LeaseLost extends Schema.TaggedError<LeaseLost>()('LeaseLost', { scanId: Schema.String }) {}

/** Public summaries stored on a scan. Details go to the log and to `scan_jobs.last_error`. */
const summaries = {
  database: 'The library database became unavailable.',
  defect: 'The scan stopped unexpectedly.',
  crashed: 'The scan worker stopped before the scan finished.',
} as const;

const MAX_ERROR_LENGTH = 4000;

export type Status = {
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
export interface Interface {
  /** Looks for work now instead of at the next poll. Only the process holding the lock acts on it. */
  readonly wake: () => Effect.Effect<void>;
  readonly status: () => Effect.Effect<Status>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/ScanWorker') {}

/** Requires `Database`, `Scanner`, and `ScanEvents`. The worker runs for as long as the layer lives. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* Database.Service;
    const scanner = yield* Scanner.Service;
    const events = yield* ScanEvents.Service;
    const policy = yield* ScanQueuePolicy;
    const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    const lockExpirationMs = Duration.toMillis(policy.lockExpiration);
    const cleanupIntervalMs = Duration.toMillis(policy.cleanupInterval);
    const maintenanceIntervalMs = Duration.toMillis(policy.maintenanceInterval);
    const wakeups = yield* Queue.sliding<void>(1);
    const state = {
      leader: false,
      currentScanId: null as string | null,
      lastCleanupMs: -Infinity,
      lastMaintenanceMs: -Infinity,
    };

    const waitForWork = (interval: Duration.Input) =>
      Queue.take(wakeups).pipe(Effect.timeoutOption(interval), Effect.asVoid);

    /** Retries the attempt if attempts remain; otherwise fails the job and the scan. */
    const settleFailure = Effect.fnUntraced(function* (lease: Lease, job: ScanJobRow, summary: string, error: string) {
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
    const settle = Effect.fnUntraced(
      function* (lease: Lease, job: ScanJobRow, exit: Exit.Exit<void, LeaseLost | DatabaseUnavailable>) {
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
      },
      // The lease expires on its own, and the next worker retries the scan.
      Effect.catchTag('DatabaseUnavailable', (error) =>
        Effect.logWarning('Could not record the scan attempt; it will be retried when its lease expires', error.cause),
      ),
    );

    /** Renews the lease until the attempt ends. Fails only if the lease is gone. */
    const renewals = Effect.fnUntraced(
      function* (lease: Lease) {
        yield* Effect.sleep(policy.lockRefreshInterval);
        const held = yield* renewLease(db, lease, lockExpirationMs).pipe(
          // A brief database outage does not end the attempt; the next renewal tries again.
          Effect.catchTag('DatabaseUnavailable', () => Effect.succeed(true)),
        );
        if (!held) return yield* new LeaseLost({ scanId: lease.scanId });
      },
      (effect) => Effect.forever(effect),
    );

    const runJob = Effect.fn('ScanWorker.runJob')(
      function* (job: ScanJobRow) {
        yield* Effect.annotateCurrentSpan({ scanId: job.scanRunId, attempt: job.attempts });
        const lease: Lease = { scanId: job.scanRunId, lockedBy: workerId };
        yield* Effect.logInfo('Scan attempt started');
        state.currentScanId = job.scanRunId;
        yield* scanner.run(job.scanRunId as ScanId).pipe(
          Effect.raceFirst(renewals(lease)),
          Effect.onExit((exit) => settle(lease, job, exit)),
          Effect.ensuring(Effect.sync(() => (state.currentScanId = null))),
          // `settle` recorded the outcome. A failed or defective attempt must not end the worker loop,
          // so log it (with the cause, which the job's summary leaves out) and go on; only interruption
          // propagates. `Effect.ignore` would not do: it leaves defects uncaught.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logError('Scan attempt ended without finishing', Cause.pretty(cause)),
          ),
        );
      },
      (effect, job) => Effect.annotateLogs(effect, { scanId: job.scanRunId, attempt: job.attempts }),
    );

    /**
     * Recovers crashed workers' jobs and removes old jobs. Runs when this process becomes the
     * worker and then every `maintenanceInterval`, not on every poll.
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

    const consume = Effect.fnUntraced(
      function* (leadership: Leadership) {
        yield* leadership.check;
        yield* maintain;
        const job = yield* claimNextJob(db, workerId, lockExpirationMs);
        if (job) yield* runJob(job);
        else yield* waitForWork(policy.pollInterval);
      },
      (effect) => Effect.forever(effect),
    );

    /** One term as the worker: take the lock and consume jobs until the lock's connection fails. */
    const term = Effect.gen(function* () {
      const leadership = yield* tryLeadership(db.$client);
      if (Option.isNone(leadership)) return;
      state.leader = true;
      state.lastMaintenanceMs = -Infinity;
      yield* Effect.logInfo('This process is now the scan worker');
      yield* consume(leadership.value);
    }).pipe(Effect.ensuring(Effect.sync(() => (state.leader = false))), Effect.scoped);

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

    const wake = Effect.fn('ScanWorker.wake')(function* () {
      yield* Queue.offer(wakeups, undefined);
    });

    const status = Effect.fn('ScanWorker.status')(function* () {
      return { workerId, leader: state.leader, currentScanId: state.currentScanId };
    });

    return Service.of({ wake, status });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(Scanner.defaultLayer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(ScanEvents.defaultLayer),
);

export * as ScanWorker from './worker';
