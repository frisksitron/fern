import { and, asc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { scanJobs, scanRuns } from '$lib/server/db/schema';
import { orUnavailable, type Database } from '$lib/server/db/service';
import type { ScanId } from '$lib/shared/contracts/ids';
import { transitionScanStatement } from './persistence';

export type ScanJobRow = typeof scanJobs.$inferSelect;

/**
 * Identifies one lease on a job. Settling a job only succeeds while the worker still holds that
 * lease, so a worker whose lease expired cannot overwrite what the next worker did.
 */
export type Lease = {
  readonly scanId: string;
  readonly lockedBy: string;
  /** Settle only if the lease has also expired: used to recover jobs from crashed workers. */
  readonly expired?: boolean;
};

const afterMillis = (ms: number) => sql`now() + ${ms} * interval '1 millisecond'`;
const beforeMillis = (ms: number) => sql`now() - ${ms} * interval '1 millisecond'`;

function heldBy(lease: Lease) {
  return and(
    eq(scanJobs.scanRunId, lease.scanId),
    eq(scanJobs.state, 'running'),
    eq(scanJobs.lockedBy, lease.lockedBy),
    lease.expired ? lt(scanJobs.lockedUntil, sql`now()`) : undefined,
  );
}

/**
 * The statement that offers a scan's job. Run it in the transaction that creates the scan, so a scan
 * is never accepted without a job. Offering the same scan twice does nothing.
 */
export function offerJobStatement(db: Database.Client | Database.Transaction, scanId: ScanId, maxAttempts: number) {
  return db.insert(scanJobs).values({ scanRunId: scanId, maxAttempts }).onConflictDoNothing();
}

/** Leases the next due job to `workerId` and starts its next attempt. */
export function claimNextJob(db: Database.Client, workerId: string, lockExpirationMs: number) {
  return orUnavailable(
    db.transaction((tx) =>
      Effect.gen(function* () {
        const next = tx
          .select({ scanRunId: scanJobs.scanRunId })
          .from(scanJobs)
          .where(and(eq(scanJobs.state, 'pending'), lte(scanJobs.availableAt, sql`now()`)))
          .orderBy(asc(scanJobs.availableAt), asc(scanJobs.createdAt))
          .limit(1)
          .for('update', { skipLocked: true });
        const [job] = yield* tx
          .update(scanJobs)
          .set({
            state: 'running',
            attempts: sql`${scanJobs.attempts} + 1`,
            lockedBy: workerId,
            lockedUntil: afterMillis(lockExpirationMs),
          })
          .where(inArray(scanJobs.scanRunId, next))
          .returning();
        if (job) yield* tx.update(scanRuns).set({ attempts: job.attempts }).where(eq(scanRuns.id, job.scanRunId));
        return job;
      }),
    ),
  );
}

/** Extends a lease. False means the lease is gone: it expired and another worker may own the job. */
export function renewLease(db: Database.Client, lease: Lease, lockExpirationMs: number) {
  return orUnavailable(
    db
      .update(scanJobs)
      .set({ lockedUntil: afterMillis(lockExpirationMs) })
      .where(heldBy(lease))
      .returning({ scanRunId: scanJobs.scanRunId }),
  ).pipe(Effect.map((rows) => rows.length > 0));
}

/** Marks the job done. False means the lease was lost first. The scanner has already recorded the scan's own result. */
export function completeJob(db: Database.Client, lease: Lease) {
  return orUnavailable(
    db
      .update(scanJobs)
      .set({ state: 'completed', lockedBy: null, lockedUntil: null, finishedAt: sql`now()` })
      .where(heldBy(lease))
      .returning({ scanRunId: scanJobs.scanRunId }),
  ).pipe(Effect.map((rows) => rows.length > 0));
}

/** Schedules the next attempt and shows the scan as retrying. */
export function retryJob(
  db: Database.Client,
  lease: Lease,
  retry: { readonly delayMs: number; readonly error: string; readonly summary: string },
) {
  return orUnavailable(
    db.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .update(scanJobs)
          .set({
            state: 'pending',
            lockedBy: null,
            lockedUntil: null,
            availableAt: afterMillis(retry.delayMs),
            lastError: retry.error,
          })
          .where(heldBy(lease))
          .returning({ scanRunId: scanJobs.scanRunId });
        if (!rows.length) return false;
        yield* transitionScanStatement(tx, lease.scanId, 'retrying', {
          errorSummary: retry.summary,
          currentPath: null,
        });
        return true;
      }),
    ),
  );
}

/** Gives up on the job and fails the scan, in one transaction. */
export function failJob(
  db: Database.Client,
  lease: Lease,
  failure: { readonly error: string; readonly summary: string },
) {
  return orUnavailable(
    db.transaction((tx) =>
      Effect.gen(function* () {
        const rows = yield* tx
          .update(scanJobs)
          .set({ state: 'failed', lockedBy: null, lockedUntil: null, lastError: failure.error, finishedAt: sql`now()` })
          .where(heldBy(lease))
          .returning({ scanRunId: scanJobs.scanRunId });
        if (!rows.length) return false;
        yield* transitionScanStatement(tx, lease.scanId, 'failed', {
          completedAt: new Date(),
          currentPath: null,
          errorSummary: failure.summary,
        });
        return true;
      }),
    ),
  );
}

/**
 * Hands a job back after a graceful shutdown without using up an attempt. The scan shows as queued
 * until a worker picks it up again.
 */
export function releaseJob(db: Database.Client, lease: Lease) {
  return orUnavailable(
    db.transaction((tx) =>
      Effect.gen(function* () {
        const [job] = yield* tx
          .update(scanJobs)
          .set({
            state: 'pending',
            attempts: sql`greatest(${scanJobs.attempts} - 1, 0)`,
            lockedBy: null,
            lockedUntil: null,
            availableAt: sql`now()`,
          })
          .where(heldBy(lease))
          .returning({ attempts: scanJobs.attempts });
        if (!job) return false;
        yield* transitionScanStatement(tx, lease.scanId, 'queued', { attempts: job.attempts, currentPath: null });
        return true;
      }),
    ),
  );
}

/** Jobs whose worker stopped renewing its lease: the process crashed or lost the database. */
export function findExpiredLeases(db: Database.Client) {
  return orUnavailable(
    db
      .select()
      .from(scanJobs)
      .where(and(eq(scanJobs.state, 'running'), lt(scanJobs.lockedUntil, sql`now()`))),
  );
}

/** Deletes finished jobs past their retention. Scan history in `scan_runs` is not affected. */
export function deleteFinishedJobs(
  db: Database.Client,
  retention: { readonly completedMs: number; readonly failedMs: number },
) {
  return orUnavailable(
    db
      .delete(scanJobs)
      .where(
        or(
          and(eq(scanJobs.state, 'completed'), lt(scanJobs.finishedAt, beforeMillis(retention.completedMs))),
          and(eq(scanJobs.state, 'failed'), lt(scanJobs.finishedAt, beforeMillis(retention.failedMs))),
        ),
      )
      .returning({ scanRunId: scanJobs.scanRunId }),
  ).pipe(Effect.map((rows) => rows.length));
}
