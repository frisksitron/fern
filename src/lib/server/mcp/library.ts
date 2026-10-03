import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { mediaEntries, mediaRoots, playbackProgress, profiles } from '$lib/server/db/schema';
import { query } from '$lib/server/db/service';
import { ProfileNotFound } from '$lib/server/library/errors';
import { hasResumableProgress } from '$lib/shared/playback-state';
import { sortEntries } from '$lib/shared/sorting';

type LibraryEntryKind = 'file' | 'directory';

export class DirectoryNotFound extends Schema.TaggedError<DirectoryNotFound>()('DirectoryNotFound', {
  id: Schema.String,
}) {}

/** A library path as names from the root down, such as `['Music', 'Artist', 'Album', 'Song.flac']`. */
export function breadcrumb(rootName: string, relativePath: string): string[] {
  return [rootName, ...relativePath.split('/')];
}

/** Videos and folders whose library path contains every word of `text`. */
export const searchLibrary = Effect.fn('searchLibrary')(function* (
  text: string,
  kind: LibraryEntryKind | undefined,
  limit: number,
) {
  const tokens = text.trim().toLocaleLowerCase().split(/\s+/);
  const rows = yield* query((db) =>
    db
      .select({
        id: mediaEntries.id,
        name: mediaEntries.name,
        kind: mediaEntries.kind,
        mediaRootId: mediaEntries.mediaRootId,
        rootName: mediaRoots.displayName,
        relativePath: mediaEntries.relativePath,
        durationMs: mediaEntries.durationMs,
      })
      .from(mediaEntries)
      .innerJoin(mediaRoots, eq(mediaRoots.id, mediaEntries.mediaRootId))
      .where(
        and(
          isNull(mediaEntries.deletedAt),
          or(eq(mediaEntries.kind, 'directory'), eq(mediaEntries.isVideo, true)),
          kind ? eq(mediaEntries.kind, kind) : undefined,
          ...tokens.map((token) => sql`position(${token} in lower(${mediaEntries.relativePath})) > 0`),
        ),
      )
      .orderBy(asc(mediaEntries.kind), asc(mediaEntries.relativePath))
      .limit(limit),
  );
  return {
    results: rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind as LibraryEntryKind,
      mediaRootId: row.mediaRootId,
      rootName: row.rootName,
      breadcrumb: breadcrumb(row.rootName, row.relativePath),
      durationMs: row.durationMs,
    })),
  };
});

/**
 * The videos below a directory, at any depth. The recursive query walks `parent_id` down from the
 * directory with index lookups and carries the columns it filters on, so only the subtree is read.
 */
export function subtreeVideosQuery(directoryId: string) {
  return sql`
    with recursive tree(id, kind, is_video) as (
      select id, kind, is_video from media_entries
      where id = ${directoryId} and kind = 'directory' and deleted_at is null
      union all
      select child.id, child.kind, child.is_video
      from media_entries child join tree on child.parent_id = tree.id
      where tree.kind = 'directory' and child.deleted_at is null
    )
    select id from tree where kind = 'file' and is_video`;
}

export const getDirectoryProgress = Effect.fn('getDirectoryProgress')(function* (
  profileId: string,
  directoryId: string,
  recursive: boolean,
) {
  const [[profile], [directory]] = yield* Effect.all(
    [
      query((db) =>
        db.select({ id: profiles.id, name: profiles.name }).from(profiles).where(eq(profiles.id, profileId)).limit(1),
      ),
      query((db) =>
        db
          .select({
            id: mediaEntries.id,
            name: mediaEntries.name,
            mediaRootId: mediaEntries.mediaRootId,
            rootName: mediaRoots.displayName,
            relativePath: mediaEntries.relativePath,
          })
          .from(mediaEntries)
          .innerJoin(mediaRoots, eq(mediaRoots.id, mediaEntries.mediaRootId))
          .where(
            and(eq(mediaEntries.id, directoryId), eq(mediaEntries.kind, 'directory'), isNull(mediaEntries.deletedAt)),
          )
          .limit(1),
      ),
    ],
    { concurrency: 2 },
  );

  if (!profile) return yield* new ProfileNotFound({ id: profileId });
  if (!directory) return yield* new DirectoryNotFound({ id: directoryId });

  const videoIds = recursive
    ? (yield* query((db) => db.execute<{ id: string }>(subtreeVideosQuery(directory.id), 'objects'))).map(
        (row) => row.id,
      )
    : null;
  const rows =
    videoIds?.length === 0
      ? []
      : yield* query((db) =>
          db
            .select({
              id: mediaEntries.id,
              name: mediaEntries.name,
              relativePath: mediaEntries.relativePath,
              sortOrder: mediaEntries.sortOrder,
              durationMs: mediaEntries.durationMs,
              positionMs: playbackProgress.positionMs,
              progressDurationMs: playbackProgress.durationMs,
              watched: playbackProgress.watched,
            })
            .from(mediaEntries)
            .leftJoin(
              playbackProgress,
              and(eq(playbackProgress.mediaEntryId, mediaEntries.id), eq(playbackProgress.profileId, profileId)),
            )
            .where(
              videoIds
                ? inArray(mediaEntries.id, videoIds)
                : and(
                    eq(mediaEntries.parentId, directory.id),
                    eq(mediaEntries.kind, 'file'),
                    eq(mediaEntries.isVideo, true),
                    isNull(mediaEntries.deletedAt),
                  ),
            ),
        );

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const ordered = recursive
    ? [...rows].sort(
        (left, right) => collator.compare(left.relativePath, right.relativePath) || left.id.localeCompare(right.id),
      )
    : sortEntries(rows.map((row) => ({ ...row, kind: 'file' })));
  const watchedVideos = ordered.filter((row) => row.watched === true);
  const inProgressVideos = ordered.filter((row) =>
    hasResumableProgress({ positionMs: row.positionMs ?? 0, watched: row.watched }),
  );
  const remainingVideos = ordered.filter((row) => row.watched !== true);
  const knownDurations = ordered.filter((row) => (row.progressDurationMs ?? row.durationMs) != null);
  const remainingDurationMs = remainingVideos.reduce((total, row) => {
    const durationMs = row.progressDurationMs ?? row.durationMs;
    return durationMs == null ? total : total + Math.max(0, durationMs - (row.positionMs ?? 0));
  }, 0);
  const next = remainingVideos[0];

  return {
    profile,
    directory: {
      id: directory.id,
      name: directory.name,
      mediaRootId: directory.mediaRootId,
      rootName: directory.rootName,
      breadcrumb: breadcrumb(directory.rootName, directory.relativePath),
    },
    recursive,
    totalVideos: ordered.length,
    watchedVideos: watchedVideos.length,
    inProgressVideos: inProgressVideos.length,
    unstartedVideos: remainingVideos.length - inProgressVideos.length,
    remainingVideos: remainingVideos.length,
    durationKnownVideos: knownDurations.length,
    remainingDurationMs,
    nextVideo: next
      ? {
          id: next.id,
          name: next.name,
          breadcrumb: breadcrumb(directory.rootName, next.relativePath),
          durationMs: next.progressDurationMs ?? next.durationMs,
          positionMs: next.positionMs ?? 0,
        }
      : null,
  };
});
