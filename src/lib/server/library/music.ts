import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { Effect } from 'effect';
import { mediaEntries, playlistItems, playlists } from '$lib/server/db/schema';
import { query } from '$lib/server/db/service';
import type { PlaylistId, ProfileId } from '$lib/shared/contracts/ids';
import type { PlaylistItem } from '$lib/zero/schema';
import { PlaylistNotFound } from './errors';
import { mediaEntryColumns, toMediaEntry, toPlaylist, toPlaylistItem } from './rows';

/** What every music page shows around its content: the profile's playlists. */
export const loadMusicShell = Effect.fn('loadMusicShell')((profileId: ProfileId) =>
  query((db) =>
    db.select().from(playlists).where(eq(playlists.profileId, profileId)).orderBy(asc(playlists.createdAt)),
  ).pipe(Effect.map((rows) => ({ playlists: rows.map(toPlaylist) }))),
);

/** One of the profile's playlists with its items and the songs that still exist, in playlist order. */
export const loadPlaylistPage = Effect.fn('loadPlaylistPage')(function* (profileId: ProfileId, playlistId: PlaylistId) {
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

const loadTracks = Effect.fnUntraced(function* (items: readonly PlaylistItem[]) {
  const trackIds = items.map((item) => item.mediaEntryId);
  const rows = trackIds.length
    ? yield* query((db) =>
        db
          .select(mediaEntryColumns)
          .from(mediaEntries)
          .where(
            and(inArray(mediaEntries.id, trackIds), eq(mediaEntries.isAudio, true), isNull(mediaEntries.deletedAt)),
          ),
      )
    : [];
  const trackById = new Map(rows.map((row) => [row.id, toMediaEntry(row)]));
  return items.flatMap((item) => trackById.get(item.mediaEntryId) ?? []);
});
