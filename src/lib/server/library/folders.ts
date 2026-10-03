import { and, asc, eq, isNull, or } from 'drizzle-orm';
import { Effect } from 'effect';
import { mediaEntries, mediaRoots } from '$lib/server/db/schema';
import { query } from '$lib/server/db/service';
import { MediaRootNotFound } from '$lib/server/media-roots/errors';
import type { MediaEntryId, MediaRootId } from '$lib/shared/contracts/ids';
import type { MediaFolderSnapshot } from '$lib/shared/media-folder-data';
import { sortEntries } from '$lib/shared/sorting';
import type { MediaEntry, MediaRoot } from '$lib/zero/schema';
import { FolderNotFound } from './errors';
import { mediaEntryColumns, toMediaEntry } from './rows';
import { countRows, type QueryStats } from './stats';

/** Folders deeper than this are treated as a broken parent chain. */
const MAX_FOLDER_DEPTH = 64;

/** The media roots of one media type, or all of them, as Zero synchronizes them. */
export const loadMediaRoots = Effect.fn('loadMediaRoots')(
  (mediaType: 'video' | 'music' | null, stats: QueryStats = { queries: 0, rows: 0 }) =>
    countRows(
      stats,
      query((db) =>
        db
          .select({
            id: mediaRoots.id,
            path: mediaRoots.path,
            displayName: mediaRoots.displayName,
            mediaType: mediaRoots.mediaType,
            displayOrder: mediaRoots.displayOrder,
            lastScannedAt: mediaRoots.lastScannedAt,
            source: mediaRoots.source,
          })
          .from(mediaRoots)
          .where(mediaType ? eq(mediaRoots.mediaType, mediaType) : undefined)
          .orderBy(asc(mediaRoots.displayOrder)),
      ),
    ).pipe(
      Effect.map((rows): MediaRoot[] =>
        rows.map((root) => ({ ...root, lastScannedAt: root.lastScannedAt?.getTime() ?? null })),
      ),
    ),
);

/**
 * One folder of a media root: its children and the trail of folders above it. Reads only the
 * roots, the folder's ancestors (one row per level), and its children. Without a root, only the
 * roots of that media type.
 */
export const loadMediaFolder = Effect.fn('loadMediaFolder')(function* (
  mediaType: 'video' | 'music',
  rootId: MediaRootId | null = null,
  folderId: MediaEntryId | null = null,
  stats: QueryStats = { queries: 0, rows: 0 },
) {
  const roots = yield* loadMediaRoots(mediaType, stats);
  if (!rootId) return { rootId, folderId, roots, entries: [], folder: null, trail: [] } satisfies MediaFolderSnapshot;
  if (!roots.some((root) => root.id === rootId)) return yield* new MediaRootNotFound({ id: rootId });

  const trail: MediaEntry[] = [];
  for (let ancestorId: string | null = folderId; ancestorId;) {
    const [ancestor] = yield* countRows(
      stats,
      query((db) =>
        db
          .select(mediaEntryColumns)
          .from(mediaEntries)
          .where(
            and(
              eq(mediaEntries.id, ancestorId!),
              eq(mediaEntries.mediaRootId, rootId),
              eq(mediaEntries.kind, 'directory'),
              isNull(mediaEntries.deletedAt),
            ),
          )
          .limit(1),
      ),
    );
    if (!ancestor || trail.length >= MAX_FOLDER_DEPTH)
      return yield* new FolderNotFound({ rootId, folderId: folderId! });
    trail.unshift(toMediaEntry(ancestor));
    ancestorId = ancestor.parentId;
  }

  const childRows = yield* countRows(
    stats,
    query((db) =>
      db
        .select(mediaEntryColumns)
        .from(mediaEntries)
        .where(
          and(
            eq(mediaEntries.mediaRootId, rootId),
            folderId === null ? isNull(mediaEntries.parentId) : eq(mediaEntries.parentId, folderId),
            isNull(mediaEntries.deletedAt),
            or(
              eq(mediaEntries.kind, 'directory'),
              eq(mediaType === 'video' ? mediaEntries.isVideo : mediaEntries.isAudio, true),
            ),
          ),
        ),
    ),
  );

  return {
    rootId,
    folderId,
    roots,
    entries: sortEntries(childRows.map(toMediaEntry)),
    folder: trail.at(-1) ?? null,
    trail,
  } satisfies MediaFolderSnapshot;
});
