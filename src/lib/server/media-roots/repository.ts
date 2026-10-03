import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import { mediaRoots, scanRuns } from '$lib/server/db/schema';
import { Database, orUnavailable, uniqueViolation, type DatabaseUnavailable } from '$lib/server/db/service';
import { pathsOverlap } from '$lib/server/media/paths';
import { activeScanStates } from '$lib/server/scans/state';
import { MediaRootId } from '$lib/shared/contracts/ids';
import type { MediaRootSummary } from '$lib/shared/contracts/media-roots';
import { MediaRootBusy, MediaRootManaged, MediaRootNotFound, MediaRootOverlap } from './errors';

export type NewMediaRoot = Omit<MediaRootSummary, 'displayOrder'>;

export interface Interface {
  /**
   * Appends the root after every existing one unless it overlaps an existing root. Concurrent
   * calls are serialized, so two overlapping roots can never both be inserted.
   */
  readonly insertIfNoOverlap: (
    root: NewMediaRoot,
  ) => Effect.Effect<MediaRootSummary, MediaRootOverlap | DatabaseUnavailable>;
  /**
   * Deletes a root and, through cascades, its entries, tracks, subtitles, and progress. Refused
   * while a scan is active, so a scan never writes into a root that is being removed, and for the
   * YouTube library, which Fern owns.
   */
  readonly remove: (
    id: MediaRootId,
  ) => Effect.Effect<void, MediaRootNotFound | MediaRootBusy | MediaRootManaged | DatabaseUnavailable>;
  /**
   * The YouTube library's root at `path`: created on first use, after every existing root, and
   * moved when `DOWNLOADS_DIR` changes. Like any root, it may not overlap another.
   */
  readonly ensureYouTubeRoot: (path: string) => Effect.Effect<MediaRootId, MediaRootOverlap | DatabaseUnavailable>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/MediaRootRepository') {}

/** The PostgreSQL implementation. Requires `Database`. */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* Database.Service;

    // SHARE ROW EXCLUSIVE conflicts with itself and with every write, so root changes run their
    // overlap check one at a time while reads (including Zero replication) continue.
    const lockRoots = (tx: Database.Transaction) =>
      tx.execute(sql`lock table ${mediaRoots} in share row exclusive mode`);

    const insertIfNoOverlap = Effect.fn('MediaRootRepository.insertIfNoOverlap')(function* (root: NewMediaRoot) {
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lockRoots(tx);
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
          orUnavailable,
        );
      if (result.outcome === 'overlap')
        return yield* new MediaRootOverlap({ path: root.path, conflictingRootId: result.conflictingRootId });
      return result.root;
    });

    const remove = Effect.fn('MediaRootRepository.remove')(function* (id: MediaRootId) {
      const outcome = yield* db
        .transaction((tx) =>
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
            const [root] = yield* tx
              .select({ source: mediaRoots.source })
              .from(mediaRoots)
              .where(eq(mediaRoots.id, id))
              .limit(1);
            if (!root) return 'missing' as const;
            if (root.source !== 'folder') return 'managed' as const;
            yield* tx.delete(mediaRoots).where(eq(mediaRoots.id, id));
            return 'deleted' as const;
          }),
        )
        .pipe(orUnavailable);
      if (outcome === 'busy') return yield* new MediaRootBusy({ id });
      if (outcome === 'missing') return yield* new MediaRootNotFound({ id });
      if (outcome === 'managed') return yield* new MediaRootManaged({ id });
    });

    const ensureYouTubeRoot = Effect.fn('MediaRootRepository.ensureYouTubeRoot')(function* (path: string) {
      const result = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            // The same lock as creation, so the overlap check cannot race a folder being added.
            yield* lockRoots(tx);
            const existing = yield* tx
              .select({
                id: mediaRoots.id,
                path: mediaRoots.path,
                displayOrder: mediaRoots.displayOrder,
                source: mediaRoots.source,
              })
              .from(mediaRoots);
            const current = existing.find((row) => row.source === 'youtube');
            if (current?.path === path) return { outcome: 'ready' as const, id: current.id };
            const conflict = existing.find((row) => row.id !== current?.id && pathsOverlap(row.path, path));
            if (conflict) return { outcome: 'overlap' as const, conflictingRootId: conflict.id };
            if (current) {
              yield* tx
                .update(mediaRoots)
                .set({ path, updatedAt: sql`now()` })
                .where(eq(mediaRoots.id, current.id));
              return { outcome: 'ready' as const, id: current.id };
            }
            const id = randomUUID();
            yield* tx.insert(mediaRoots).values({
              id,
              path,
              displayName: 'YouTube',
              mediaType: 'music',
              source: 'youtube',
              displayOrder: Math.max(-1, ...existing.map((row) => row.displayOrder)) + 1,
            });
            return { outcome: 'ready' as const, id };
          }),
        )
        .pipe(orUnavailable);
      if (result.outcome === 'overlap')
        return yield* new MediaRootOverlap({ path, conflictingRootId: result.conflictingRootId });
      return MediaRootId.make(result.id);
    });

    return Service.of({ insertIfNoOverlap, remove, ensureYouTubeRoot });
  }),
);

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer));

export * as MediaRootRepository from './repository';
