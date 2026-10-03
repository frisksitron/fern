import { randomUUID } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import { mediaRoots, scanRuns } from '$lib/server/db/schema';
import { Database, orUnavailable, uniqueViolation, type DatabaseUnavailable } from '$lib/server/db/service';
import { MediaRootNotFound } from '$lib/server/media-roots/errors';
import { ScanId, type MediaRootId } from '$lib/shared/contracts/ids';
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
export interface Interface {
  /**
   * Accepts a scan of one root, or of every root without one: the scan row and its delivery job
   * commit in one transaction, so an accepted scan always runs, even if this process stops right
   * after answering.
   */
  readonly start: (
    rootId: MediaRootId | null,
  ) => Effect.Effect<ScanId, ScanAlreadyRunning | MediaRootNotFound | DatabaseUnavailable>;
  /** The active scan, read from the database. */
  readonly status: () => Effect.Effect<ScanStatusResponse, DatabaseUnavailable>;
  readonly get: (id: ScanId) => Effect.Effect<ScanRun, ScanNotFound | DatabaseUnavailable>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/Scans') {}

/** Requires `Database` and `ScanWorker`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* Database.Service;
    const worker = yield* ScanWorker.Service;
    const policy = yield* ScanQueuePolicy;

    const activeScanId = orUnavailable(
      db
        .select({ id: scanRuns.id })
        .from(scanRuns)
        .where(inArray(scanRuns.state, [...activeScanStates]))
        .limit(1),
    ).pipe(Effect.map(([row]) => row?.id ?? null));

    const start = Effect.fn('Scans.start')(function* (rootId: MediaRootId | null) {
      if (rootId) {
        const [root] = yield* orUnavailable(
          db.select({ id: mediaRoots.id }).from(mediaRoots).where(eq(mediaRoots.id, rootId)).limit(1),
        );
        if (!root) return yield* new MediaRootNotFound({ id: rootId });
      }
      const scanId = ScanId.make(randomUUID());
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(scanRuns).values({ id: scanId, state: 'queued', rootId });
            yield* offerJobStatement(tx, scanId, policy.maxAttempts);
          }),
        )
        .pipe(
          Effect.catchIf(
            (error) => uniqueViolation(error) === 'scan_single_active',
            () => Effect.flatMap(activeScanId, (active) => Effect.fail(new ScanAlreadyRunning({ scanId: active }))),
          ),
          orUnavailable,
        );
      yield* worker.wake();
      return scanId;
    });

    const status = Effect.fn('Scans.status')(function* () {
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

    const get = Effect.fn('Scans.get')(function* (id: ScanId) {
      const [row] = yield* orUnavailable(db.select().from(scanRuns).where(eq(scanRuns.id, id)).limit(1));
      if (!row) return yield* new ScanNotFound({ id });
      return toScanRun(row);
    });

    return Service.of({ start, status, get });
  }),
);

export const defaultLayer = layer.pipe(Layer.provide(ScanWorker.defaultLayer), Layer.provide(Database.defaultLayer));

export * as Scans from './service';
