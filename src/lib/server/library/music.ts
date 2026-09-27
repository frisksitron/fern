import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { Effect } from 'effect';
import { mediaEntries, playlistItems, playlists } from '$lib/server/db/schema';
import { query } from '$lib/server/db/service';
import type { PlaylistId, ProfileId } from '$lib/shared/contracts/ids';
import type { MediaEntry, PlaylistItem } from '$lib/zero/schema';
import { PlaylistNotFound } from './errors';
import { mediaEntryColumns, toMediaEntry, toPlaylist, toPlaylistItem } from './rows';

/** What every music page shows around its content: the profile's playlists. */
export function loadMusicShell(profileId: ProfileId) {
  return query((db) =>
    db.select().from(playlists).where(eq(playlists.profileId, profileId)).orderBy(asc(playlists.createdAt)),
  ).pipe(Effect.map((rows) => ({ playlists: rows.map(toPlaylist) })));
}

/** One of the profile's playlists with its items and the songs that still exist, in playlist order. */
export function loadPlaylistPage(profileId: ProfileId, playlistId: PlaylistId) {
  return Effect.gen(function* () {
    const [playlist] = yield* query((db) =>
      db
        .select()
        .from(playlists)
        .where(and(eq(playlists.id, playlistId), eq(playlists.profileId, profileId)))
        .limit(1),
    );
    if (!playlist) return yield* new PlaylistNotFound({ id: playlistId });
    const itemRows = yield* query((db) =>
      db
        .select()
        .from(playlistItems)
        .where(eq(playlistItems.playlistId, playlistId))
        .orderBy(asc(playlistItems.position)),
    );
    const items = itemRows.map(toPlaylistItem);
    return { playlist: toPlaylist(playlist), items, tracks: yield* loadTracks(items) };
  });
}

function loadTracks(items: readonly PlaylistItem[]) {
  const trackIds = items.map((item) => item.mediaEntryId);
  if (!trackIds.length) return Effect.succeed<MediaEntry[]>([]);
  return query((db) =>
    db
      .select(mediaEntryColumns)
      .from(mediaEntries)
      .where(and(inArray(mediaEntries.id, trackIds), eq(mediaEntries.isAudio, true), isNull(mediaEntries.deletedAt))),
  ).pipe(
    Effect.map((rows) => {
      const trackById = new Map(rows.map((row) => [row.id, toMediaEntry(row)]));
      return items.flatMap((item) => trackById.get(item.mediaEntryId) ?? []);
    }),
  );
}
