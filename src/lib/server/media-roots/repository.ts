import { eq, inArray, sql } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import { mediaRoots, scanRuns } from '$lib/server/db/schema';
import { Database, orUnavailable, uniqueViolation, type DatabaseUnavailable } from '$lib/server/db/service';
import { pathsOverlap } from '$lib/server/media/paths';
import { activeScanStates } from '$lib/server/scans/state';
import type { MediaRootId } from '$lib/shared/contracts/ids';
import type { MediaRootSummary } from '$lib/shared/contracts/media-roots';
import { MediaRootBusy, MediaRootNotFound, MediaRootOverlap } from './errors';

export type NewMediaRoot = Omit<MediaRootSummary, 'displayOrder'>;

export class MediaRootRepository extends Context.Service<
  MediaRootRepository,
  {
    /**
     * Appends the root after every existing one unless it overlaps an existing root. Concurrent
     * calls are serialized, so two overlapping roots can never both be inserted.
     */
    readonly insertIfNoOverlap: (
      root: NewMediaRoot,
    ) => Effect.Effect<MediaRootSummary, MediaRootOverlap | DatabaseUnavailable>;
    /**
     * Deletes a root and, through cascades, its entries, tracks, subtitles, and progress. Refused
     * while a scan is active, so a scan never writes into a root that is being removed.
     */
    readonly remove: (id: MediaRootId) => Effect.Effect<void, MediaRootNotFound | MediaRootBusy | DatabaseUnavailable>;
  }
>()('fern/MediaRootRepository') {
  /** The PostgreSQL implementation. Requires `Database`. */
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const db = yield* Database;

      const insertIfNoOverlap = (root: NewMediaRoot) =>
        Effect.gen(function* () {
          const result = yield* orUnavailable(
            db
              .transaction((tx) =>
                Effect.gen(function* () {
                  // SHARE ROW EXCLUSIVE conflicts with itself and with every write, so creations run their
                  // overlap check one at a time while reads (including Zero replication) continue.
                  yield* tx.execute(sql`lock table ${mediaRoots} in share row exclusive mode`);
                  const existing = yield* tx
                    .select({ id: mediaRoots.id, path: mediaRoots.path, displayOrder: mediaRoots.displayOrder })
                    .from(mediaRoots);
                  const conflict = existing.find((row) => pathsOverlap(row.path, root.path));
                  if (conflict) return { outcome: 'overlap' as const, conflictingRootId: conflict.id };
                  const displayOrder = Math.max(-1, ...existing.map((row) => row.displayOrder)) + 1;
                  yield* tx.insert(mediaRoots).values({ ...root, displayOrder });
                  return { outcome: 'created' as const, root: { ...root, displayOrder } };
                }),
              )
              .pipe(
                Effect.catchIf(
                  (error) => uniqueViolation(error) === 'media_root_path',
                  () => Effect.succeed({ outcome: 'overlap' as const, conflictingRootId: null }),
                ),
              ),
          );
          if (result.outcome === 'overlap')
            return yield* new MediaRootOverlap({ path: root.path, conflictingRootId: result.conflictingRootId });
          return result.root;
        });

      const remove = (id: MediaRootId) =>
        Effect.gen(function* () {
          const outcome = yield* orUnavailable(
            db.transaction((tx) =>
              Effect.gen(function* () {
                // SHARE blocks scan admission (an insert) until this commits, and a scan that is
                // already active holds the one active-scan slot, which the check below sees.
                yield* tx.execute(sql`lock table ${scanRuns} in share mode`);
                const [active] = yield* tx
                  .select({ id: scanRuns.id })
                  .from(scanRuns)
                  .where(inArray(scanRuns.state, [...activeScanStates]))
                  .limit(1);
                if (active) return 'busy' as const;
                const deleted = yield* tx
                  .delete(mediaRoots)
                  .where(eq(mediaRoots.id, id))
                  .returning({ id: mediaRoots.id });
                return deleted.length ? ('deleted' as const) : ('missing' as const);
              }),
            ),
          );
          if (outcome === 'busy') return yield* new MediaRootBusy({ id });
          if (outcome === 'missing') return yield* new MediaRootNotFound({ id });
        });

      return { insertIfNoOverlap, remove };
    }),
  );
}
