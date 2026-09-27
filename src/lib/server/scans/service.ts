import { randomUUID } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import { mediaRoots, scanRuns } from '$lib/server/db/schema';
import { Database, orUnavailable, uniqueViolation, type DatabaseUnavailable } from '$lib/server/db/service';
import { MediaRootNotFound } from '$lib/server/media-roots/errors';
import { MediaRootId, ScanId } from '$lib/shared/contracts/ids';
import type { ScanRun, ScanState, ScanStatusResponse } from '$lib/shared/contracts/scans';
import { ScanAlreadyRunning, ScanNotFound } from './errors';
import { offerJobStatement } from './job-store';
import { ScanQueuePolicy } from './jobs';
import { activeScanStates } from './state';
import { ScanWorker } from './worker';

/** `scan_runs` rows come from Fern's own database, so they are trusted and cast rather than decoded. */
export function toScanRun(row: typeof scanRuns.$inferSelect): ScanRun {
  return {
    ...row,
    id: row.id as ScanId,
    state: row.state as ScanState,
    rootId: row.rootId as MediaRootId | null,
    currentRootId: row.currentRootId as MediaRootId | null,
  };
}

/** Scan admission and status. Accepted scans are delivered to the scan worker through `scan_jobs`. */
export class Scans extends Context.Service<Scans>()('fern/Scans', {
  make: Effect.gen(function* () {
    const db = yield* Database;
    const worker = yield* ScanWorker;
    const policy = yield* ScanQueuePolicy;

    const activeScanId = orUnavailable(
      db
        .select({ id: scanRuns.id })
        .from(scanRuns)
        .where(inArray(scanRuns.state, [...activeScanStates]))
        .limit(1),
    ).pipe(Effect.map(([row]) => row?.id ?? null));

    /**
     * Accepts a scan: the scan row and its delivery job commit in one transaction, so an accepted
     * scan always runs, even if this process stops right after answering.
     */
    const start = (
      rootId: MediaRootId | null,
    ): Effect.Effect<ScanId, ScanAlreadyRunning | MediaRootNotFound | DatabaseUnavailable> =>
      Effect.gen(function* () {
        if (rootId) {
          const [root] = yield* orUnavailable(
            db.select({ id: mediaRoots.id }).from(mediaRoots).where(eq(mediaRoots.id, rootId)).limit(1),
          );
          if (!root) return yield* new MediaRootNotFound({ id: rootId });
        }
        const scanId = ScanId.make(randomUUID());
        const accept = db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(scanRuns).values({ id: scanId, state: 'queued', rootId });
            yield* offerJobStatement(tx, scanId, policy.maxAttempts);
          }),
        );
        yield* orUnavailable(
          Effect.catchIf(
            accept,
            (error) => uniqueViolation(error) === 'scan_single_active',
            () => Effect.flatMap(activeScanId, (active) => Effect.fail(new ScanAlreadyRunning({ scanId: active }))),
          ),
        );
        yield* worker.wake;
        return scanId;
      });

    /** The active scan, read from the database. */
    const status: Effect.Effect<ScanStatusResponse, DatabaseUnavailable> = Effect.gen(function* () {
      const [row] = yield* orUnavailable(
        db
          .select()
          .from(scanRuns)
          .where(inArray(scanRuns.state, [...activeScanStates]))
          .orderBy(desc(scanRuns.requestedAt))
          .limit(1),
      );
      return { scan: row ? toScanRun(row) : null };
    });

    const get = (id: ScanId): Effect.Effect<ScanRun, ScanNotFound | DatabaseUnavailable> =>
      Effect.gen(function* () {
        const [row] = yield* orUnavailable(db.select().from(scanRuns).where(eq(scanRuns.id, id)).limit(1));
        if (!row) return yield* new ScanNotFound({ id });
        return toScanRun(row);
      });

    return { start, status, get } as const;
  }),
}) {
  /** Requires `Database` and `ScanWorker`. */
  static readonly layerWithoutDependencies = Layer.effect(this, this.make);
  /** Requires `Database`, `FernConfig`, and `ScanEvents` (shared with event subscribers). */
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(ScanWorker.layer));
}
