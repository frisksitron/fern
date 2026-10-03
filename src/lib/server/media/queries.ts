import { and, eq, isNull, or } from 'drizzle-orm';
import { Effect } from 'effect';
import { mediaEntries, mediaRoots } from '$lib/server/db/schema';
import type { Database } from '$lib/server/db/service';

/** The active, playable media file with this ID and its root, if any. */
export function findActiveMedia(database: Database.Client, id: string) {
  return database
    .select({ entry: mediaEntries, root: mediaRoots })
    .from(mediaEntries)
    .innerJoin(mediaRoots, eq(mediaEntries.mediaRootId, mediaRoots.id))
    .where(
      and(
        eq(mediaEntries.id, id),
        eq(mediaEntries.kind, 'file'),
        or(eq(mediaEntries.isVideo, true), eq(mediaEntries.isAudio, true)),
        isNull(mediaEntries.deletedAt),
      ),
    )
    .limit(1)
    .pipe(Effect.map((rows) => rows[0]));
}
