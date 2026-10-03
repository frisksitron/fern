import { and, eq, inArray } from 'drizzle-orm';
import { Effect } from 'effect';
import { playbackProgress } from '$lib/server/db/schema';
import { query } from '$lib/server/db/service';
import type { MediaEntryId, MediaRootId, ProfileId } from '$lib/shared/contracts/ids';
import type { BrowseSnapshot } from '$lib/shared/browse-data';
import { loadMediaFolder } from './folders';
import { toProgress } from './rows';
import { countRows, type QueryStats } from './stats';

/** A video folder and the profile's progress on the videos in it; nothing outside the folder is read. */
export const loadBrowseSnapshot = Effect.fn('loadBrowseSnapshot')(function* (
  profileId: ProfileId,
  rootId: MediaRootId | null = null,
  folderId: MediaEntryId | null = null,
  stats: QueryStats = { queries: 0, rows: 0 },
) {
  const folder = yield* loadMediaFolder('video', rootId, folderId, stats);
  const mediaIds = folder.entries.filter((entry) => entry.kind === 'file').map((entry) => entry.id);
  const progressRows = mediaIds.length
    ? yield* countRows(
        stats,
        query((db) =>
          db
            .select()
            .from(playbackProgress)
            .where(and(eq(playbackProgress.profileId, profileId), inArray(playbackProgress.mediaEntryId, mediaIds))),
        ),
      )
    : [];
  return { ...folder, folderProgress: progressRows.map(toProgress) } satisfies BrowseSnapshot;
});
