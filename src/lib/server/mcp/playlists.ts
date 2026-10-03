import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DateTime, Effect, Schema } from 'effect';
import { mediaEntries, mediaRoots, playlistItems, playlists, profiles } from '$lib/server/db/schema';
import { query, type Database } from '$lib/server/db/service';
import { PlaylistNotFound, ProfileNotFound } from '$lib/server/library/errors';
import { findProfile, isSong, playCounts, trackColumns, toTrack, withPlays } from '$lib/server/mcp/music';
import { planPlaylistAppend, planPlaylistOrder } from '$lib/music/playlists';

// These write PostgreSQL directly; Zero replicates the rows to open pages like any other change.
// Appending and ordering follow the same rules as Zero's mutators and the playlist view
// (`planPlaylistAppend`, `planPlaylistOrder`), and lock the playlist as Zero's mutators do.

/** A new order that does not list every song in the playlist exactly once. */
export class PlaylistOrderMismatch extends Schema.TaggedError<PlaylistOrderMismatch>()('PlaylistOrderMismatch', {
  /** Songs in the playlist that the order leaves out. */
  missing: Schema.Array(Schema.String),
  /** Listed IDs that are not in the playlist. */
  unknown: Schema.Array(Schema.String),
  /** IDs listed more than once. */
  repeated: Schema.Array(Schema.String),
}) {}

/** The profile's playlists, oldest first, with how many songs they hold and their total length. */
export const listPlaylists = Effect.fn('listPlaylists')(function* (profileId: string) {
  const profile = yield* findProfile(profileId);
  const rows = yield* query((db) =>
    db
      .select({
        id: playlists.id,
        name: playlists.name,
        createdAt: playlists.createdAt,
        updatedAt: playlists.updatedAt,
        trackCount: sql<number>`count(${mediaEntries.id})::int`,
        durationMs: sql<number>`coalesce(sum(${mediaEntries.durationMs}), 0)`.mapWith(Number),
      })
      .from(playlists)
      .leftJoin(playlistItems, eq(playlistItems.playlistId, playlists.id))
      .leftJoin(mediaEntries, and(eq(mediaEntries.id, playlistItems.mediaEntryId), isSong))
      .where(eq(playlists.profileId, profileId))
      .groupBy(playlists.id)
      .orderBy(asc(playlists.createdAt)),
  );
  return {
    profile,
    playlists: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
});

/** One of the profile's playlists: its songs in order, with the profile's plays of each. */
export const getPlaylist = Effect.fn('getPlaylist')(function* (profileId: string, playlistId: string) {
  const profile = yield* findProfile(profileId);
  const [playlist] = yield* query((db) =>
    db
      .select({ id: playlists.id, name: playlists.name })
      .from(playlists)
      .where(and(eq(playlists.id, playlistId), eq(playlists.profileId, profileId)))
      .limit(1),
  );
  if (!playlist) return yield* new PlaylistNotFound({ id: playlistId });
  const rows = yield* query((db) =>
    db
      .select(trackColumns)
      .from(playlistItems)
      .innerJoin(mediaEntries, eq(mediaEntries.id, playlistItems.mediaEntryId))
      .innerJoin(mediaRoots, eq(mediaRoots.id, mediaEntries.mediaRootId))
      .where(and(eq(playlistItems.playlistId, playlistId), isSong))
      .orderBy(asc(playlistItems.position), asc(playlistItems.createdAt)),
  );
  const songs = rows.map(toTrack);
  const plays = yield* playCounts(
    profileId,
    songs.map((song) => song.id),
  );
  return {
    profile,
    playlist: {
      ...playlist,
      trackCount: songs.length,
      durationMs: songs.reduce((total, song) => total + (song.durationMs ?? 0), 0),
    },
    tracks: withPlays(songs, plays),
  };
});

/**
 * Appends songs to a playlist inside `tx`, after locking it so concurrent appends from MCP take
 * turns. IDs that are not songs in the library are reported rather than added.
 */
const appendTracks = Effect.fnUntraced(function* (
  tx: Database.Transaction,
  playlistId: string,
  trackIds: readonly string[],
  now: Date,
) {
  const requested = [...new Set(trackIds)];
  const found = requested.length
    ? yield* tx
        .select({ id: mediaEntries.id })
        .from(mediaEntries)
        .where(and(inArray(mediaEntries.id, requested), isSong))
    : [];
  const existing = new Set(found.map((row) => row.id));
  // Every item, for positions and duplicates; `songId` is null for a song removed from the library.
  const items = yield* tx
    .select({ mediaEntryId: playlistItems.mediaEntryId, position: playlistItems.position, songId: mediaEntries.id })
    .from(playlistItems)
    .leftJoin(mediaEntries, and(eq(mediaEntries.id, playlistItems.mediaEntryId), isSong))
    .where(eq(playlistItems.playlistId, playlistId));
  const { added, skipped } = planPlaylistAppend(
    items,
    requested.filter((id) => existing.has(id)).map((mediaEntryId) => ({ mediaEntryId })),
  );
  if (added.length) {
    yield* tx
      .insert(playlistItems)
      .values(added.map((item) => ({ id: randomUUID(), playlistId, ...item, createdAt: now })));
  }
  return {
    added: added.map((item) => item.mediaEntryId),
    alreadyInPlaylist: skipped.map((item) => item.mediaEntryId),
    notFound: requested.filter((id) => !existing.has(id)),
    // Counted like list_playlists and get_playlist: songs that still exist.
    trackCount: items.filter((item) => item.songId !== null).length + added.length,
  };
});

/** Creates a playlist for the profile, filled with `trackIds` in order. */
export const createPlaylist = Effect.fn('createPlaylist')(function* (
  profileId: string,
  name: string,
  trackIds: readonly string[],
) {
  const id = randomUUID();
  const now = yield* DateTime.nowAsDate;
  const outcome = yield* query((db) =>
    db.transaction((tx) =>
      Effect.gen(function* () {
        const [profile] = yield* tx
          .select({ id: profiles.id, name: profiles.name })
          .from(profiles)
          .where(eq(profiles.id, profileId))
          .for('share');
        if (!profile) return null;
        yield* tx.insert(playlists).values({ id, profileId, name, createdAt: now, updatedAt: now });
        return { profile, result: yield* appendTracks(tx, id, trackIds, now) };
      }),
    ),
  );
  if (!outcome) return yield* new ProfileNotFound({ id: profileId });
  const { trackCount, ...added } = outcome.result;
  return { profile: outcome.profile, playlist: { id, name, trackCount }, ...added };
});

/** Appends `trackIds` to one of the profile's playlists, skipping songs it already holds. */
export const addToPlaylist = Effect.fn('addToPlaylist')(function* (
  profileId: string,
  playlistId: string,
  trackIds: readonly string[],
) {
  const profile = yield* findProfile(profileId);
  const now = yield* DateTime.nowAsDate;
  const outcome = yield* query((db) =>
    db.transaction((tx) =>
      Effect.gen(function* () {
        const [playlist] = yield* tx
          .select({ id: playlists.id, name: playlists.name })
          .from(playlists)
          .where(and(eq(playlists.id, playlistId), eq(playlists.profileId, profileId)))
          .for('update');
        if (!playlist) return null;
        return { playlist, result: yield* appendTracks(tx, playlistId, trackIds, now) };
      }),
    ),
  );
  if (!outcome) return yield* new PlaylistNotFound({ id: playlistId });
  const { trackCount, ...added } = outcome.result;
  return { profile, playlist: { ...outcome.playlist, trackCount }, ...added };
});

/**
 * Puts one of the profile's playlists in the order of `trackIds`, which must list every song in it
 * (as get_playlist shows them) exactly once. Items whose songs were removed from the library stay
 * after them, as the playlist view keeps them. Only positions that change are written.
 */
export const reorderPlaylist = Effect.fn('reorderPlaylist')(function* (
  profileId: string,
  playlistId: string,
  trackIds: readonly string[],
) {
  const profile = yield* findProfile(profileId);
  const outcome = yield* query((db) =>
    db.transaction((tx) =>
      Effect.gen(function* () {
        const [playlist] = yield* tx
          .select({ id: playlists.id, name: playlists.name })
          .from(playlists)
          .where(and(eq(playlists.id, playlistId), eq(playlists.profileId, profileId)))
          .for('update');
        if (!playlist) return { outcome: 'missing' as const };
        // `songId` is null for a song removed from the library, which get_playlist does not show.
        const items = yield* tx
          .select({
            id: playlistItems.id,
            mediaEntryId: playlistItems.mediaEntryId,
            position: playlistItems.position,
            songId: mediaEntries.id,
          })
          .from(playlistItems)
          .leftJoin(mediaEntries, and(eq(mediaEntries.id, playlistItems.mediaEntryId), isSong))
          .where(eq(playlistItems.playlistId, playlistId));
        const plan = planPlaylistOrder(items, trackIds);
        const missing = plan.unlisted.filter((item) => item.songId !== null).map((item) => item.mediaEntryId);
        if (missing.length || plan.unknown.length || plan.repeated.length) {
          return { outcome: 'mismatch' as const, missing, unknown: plan.unknown, repeated: plan.repeated };
        }
        for (const [position, item] of plan.ordered.entries()) {
          if (item.position !== position) {
            yield* tx.update(playlistItems).set({ position }).where(eq(playlistItems.id, item.id));
          }
        }
        const songs = plan.ordered.filter((item) => item.songId !== null).map((item) => item.mediaEntryId);
        return { outcome: 'reordered' as const, playlist, trackIds: songs };
      }),
    ),
  );
  if (outcome.outcome === 'missing') return yield* new PlaylistNotFound({ id: playlistId });
  if (outcome.outcome === 'mismatch') {
    const { missing, unknown, repeated } = outcome;
    return yield* new PlaylistOrderMismatch({ missing, unknown, repeated });
  }
  return {
    profile,
    playlist: { ...outcome.playlist, trackCount: outcome.trackIds.length },
    trackIds: outcome.trackIds,
  };
});
