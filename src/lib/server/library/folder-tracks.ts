import { sql } from 'drizzle-orm';
import { Data, Effect } from 'effect';
import { orUnavailable, type FernDatabase } from '$lib/server/db/service';
import type { MediaEntryId } from '$lib/shared/contracts/ids';
import { FOLDER_TRACK_LIMIT } from '$lib/shared/contracts/music';

/** The folder holds more tracks than one playlist change may add. */
export class FolderTooLarge extends Data.TaggedError('FolderTooLarge')<{ readonly limit: number }> {}

/**
 * The audio tracks in a folder and every folder below it, in album order. The recursive query walks
 * `parent_id` down from the folder with index lookups and carries the columns it needs, so only the
 * folder's own subtree is read. Without a folder, the whole root.
 */
export function folderTracksQuery(rootId: string, folderId: string | null, limit: number) {
  if (!folderId)
    return sql`
      select id from media_entries
      where media_root_id = ${rootId} and kind = 'file' and is_audio and deleted_at is null
      order by album nulls last, track_number nulls last, relative_path
      limit ${limit}`;
  return sql`
    with recursive tree(id, kind, is_audio, album, track_number, relative_path) as (
      select id, kind, is_audio, album, track_number, relative_path from media_entries
      where id = ${folderId} and media_root_id = ${rootId} and kind = 'directory' and deleted_at is null
      union all
      select child.id, child.kind, child.is_audio, child.album, child.track_number, child.relative_path
      from media_entries child join tree on child.parent_id = tree.id
      where tree.kind = 'directory' and child.deleted_at is null
    )
    select id from tree where kind = 'file' and is_audio
    order by album nulls last, track_number nulls last, relative_path
    limit ${limit}`;
}

export function folderTrackIds(db: FernDatabase, rootId: string, folderId: string | null) {
  return Effect.gen(function* () {
    const rows = yield* orUnavailable(
      db.execute<{ id: string }>(folderTracksQuery(rootId, folderId, FOLDER_TRACK_LIMIT + 1), 'objects'),
    );
    if (rows.length > FOLDER_TRACK_LIMIT) return yield* new FolderTooLarge({ limit: FOLDER_TRACK_LIMIT });
    // IDs come from Fern's own database, so they are trusted and cast rather than decoded.
    return rows.map((row) => row.id as MediaEntryId);
  });
}
