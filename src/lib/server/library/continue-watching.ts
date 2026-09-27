import { and, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import { Effect } from 'effect';
import { mediaEntries, playbackProgress } from '$lib/server/db/schema';
import { query, type FernDatabase } from '$lib/server/db/service';
import type { ContinueWatching } from '$lib/shared/browse-data';
import type { ProfileId } from '$lib/shared/contracts/ids';
import { CONTINUE_WATCHING_LIMIT, RESUME_MIN_MS } from '$lib/shared/playback-state';
import { findUpNext } from '$lib/shared/sorting';
import type { MediaEntry, PlaybackProgress } from '$lib/zero/schema';
import { mediaEntryColumns, toMediaEntry, toProgress } from './rows';
import { countRows, type QueryStats } from './stats';

/** How much watch history up-next suggestions consider: the most recently finished videos. */
const RECENTLY_WATCHED_LIMIT = 200;

export type Folder = { readonly rootId: string; readonly parentId: string | null };
const folderKey = (entry: Pick<MediaEntry, 'mediaRootId' | 'parentId'>) =>
  `${entry.mediaRootId}:${entry.parentId ?? ''}`;

const liveVideo = and(isNull(mediaEntries.deletedAt), eq(mediaEntries.kind, 'file'), eq(mediaEntries.isVideo, true));

function inFolder(folder: Folder) {
  return and(
    eq(mediaEntries.mediaRootId, folder.rootId),
    folder.parentId === null ? isNull(mediaEntries.parentId) : eq(mediaEntries.parentId, folder.parentId),
  );
}

/** The videos in the given folders, one index range per folder (`entry_children`). */
export function siblingsQuery(db: FernDatabase, folders: readonly Folder[]) {
  return db
    .select(mediaEntryColumns)
    .from(mediaEntries)
    .where(and(liveVideo, or(...folders.map(inFolder))));
}

/**
 * The continue-watching row for a profile, read with bounded queries: resumable progress (up to the
 * row's limit), recent watch history, and only the folders that history points to, loaded a batch
 * at a time until the row is full. The rest of the library is never read.
 */
export function loadContinueWatching(profileId: ProfileId, stats: QueryStats = { queries: 0, rows: 0 }) {
  return Effect.gen(function* () {
    const progressWithEntry = { progress: playbackProgress, entry: mediaEntryColumns };
    const [continuing, finished] = yield* Effect.all(
      [
        countRows(
          stats,
          query((db) =>
            db
              .select(progressWithEntry)
              .from(playbackProgress)
              .innerJoin(mediaEntries, eq(mediaEntries.id, playbackProgress.mediaEntryId))
              .where(
                and(
                  eq(playbackProgress.profileId, profileId),
                  eq(playbackProgress.watched, false),
                  gte(playbackProgress.positionMs, RESUME_MIN_MS),
                  liveVideo,
                ),
              )
              .orderBy(desc(playbackProgress.lastPlayedAt))
              .limit(CONTINUE_WATCHING_LIMIT),
          ),
        ),
        countRows(
          stats,
          query((db) =>
            db
              .select(progressWithEntry)
              .from(playbackProgress)
              .innerJoin(mediaEntries, eq(mediaEntries.id, playbackProgress.mediaEntryId))
              .where(and(eq(playbackProgress.profileId, profileId), eq(playbackProgress.watched, true), liveVideo))
              .orderBy(desc(playbackProgress.lastPlayedAt))
              .limit(RECENTLY_WATCHED_LIMIT),
          ),
        ),
      ],
      { concurrency: 2 },
    );

    const progress = continuing.map((row) => toProgress(row.progress));
    const entries = continuing.map((row) => toMediaEntry(row.entry));
    const limit = CONTINUE_WATCHING_LIMIT - progress.length;
    if (limit <= 0 || !finished.length) return { progress, entries, upNext: [] } satisfies ContinueWatching;

    const known = new Map<string, MediaEntry>();
    const progressById = new Map<string, PlaybackProgress>();
    for (const row of [...continuing, ...finished]) {
      known.set(row.entry.id, toMediaEntry(row.entry));
      progressById.set(row.progress.mediaEntryId, toProgress(row.progress));
    }
    const continuingIds = new Set(progress.map((item) => item.mediaEntryId));
    const continuingFolders = new Set(entries.map(folderKey));

    // Folders in the order they were last finished, as findUpNext visits them.
    const folders = new Map<string, Folder>();
    for (const row of finished) {
      const key = folderKey(row.entry);
      if (!continuingFolders.has(key) && !folders.has(key))
        folders.set(key, { rootId: row.entry.mediaRootId, parentId: row.entry.parentId });
    }

    let upNext: MediaEntry[] = [];
    const pending = [...folders.values()];
    // Later folders cannot change suggestions for earlier ones, so stop as soon as the row is full.
    while (pending.length && upNext.length < limit) {
      const batch = pending.splice(0, CONTINUE_WATCHING_LIMIT);
      const siblings = yield* countRows(
        stats,
        query((db) => siblingsQuery(db, batch)),
      );
      for (const row of siblings) known.set(row.id, toMediaEntry(row));
      const unknownIds = siblings.map((row) => row.id).filter((id) => !progressById.has(id));
      if (unknownIds.length) {
        const rows = yield* countRows(
          stats,
          query((db) =>
            db
              .select()
              .from(playbackProgress)
              .where(
                and(eq(playbackProgress.profileId, profileId), inArray(playbackProgress.mediaEntryId, unknownIds)),
              ),
          ),
        );
        for (const row of rows) progressById.set(row.mediaEntryId, toProgress(row));
      }
      upNext = findUpNext([...known.values()], [...progressById.values()], continuingIds, limit);
    }
    return { progress, entries, upNext } satisfies ContinueWatching;
  });
}
