import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { Data, Effect } from 'effect';
import { mediaEntries, mediaRoots, profiles, trackPlays } from '$lib/server/db/schema';
import { query } from '$lib/server/db/service';
import { ProfileNotFound } from '$lib/server/library/errors';
import { breadcrumb } from '$lib/server/mcp/library';
import { fileTitle, normalizeArtist, normalizeText, TrackMatcher, type TrackQuery } from '$lib/music/matching';

export class ArtistNotFound extends Data.TaggedError('ArtistNotFound')<{ readonly name: string }> {}

/** The most songs `get_artist` lists; a larger discography is cut off and says so. */
export const ARTIST_TRACK_LIMIT = 500;

/** A song as MCP tools describe it. Songs without a title tag are named after their file. */
export type Track = {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNumber: number | null;
  durationMs: number | null;
  breadcrumb: string[];
};

/** A song with how often the profile has played it. */
export type TrackWithPlays = Track & { playCount: number; lastPlayedAt: string | null };

export const trackColumns = {
  id: mediaEntries.id,
  name: mediaEntries.name,
  title: mediaEntries.title,
  artist: mediaEntries.artist,
  album: mediaEntries.album,
  albumArtist: mediaEntries.albumArtist,
  trackNumber: mediaEntries.trackNumber,
  durationMs: mediaEntries.durationMs,
  relativePath: mediaEntries.relativePath,
  rootName: mediaRoots.displayName,
};

type TrackRow = {
  id: string;
  name: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  trackNumber: number | null;
  durationMs: number | null;
  relativePath: string;
  rootName: string;
};

export function toTrack(row: TrackRow): Track {
  return {
    id: row.id,
    title: row.title ?? fileTitle(row.name),
    artist: row.artist,
    album: row.album,
    albumArtist: row.albumArtist,
    trackNumber: row.trackNumber,
    durationMs: row.durationMs,
    breadcrumb: breadcrumb(row.rootName, row.relativePath),
  };
}

/** Songs that exist: audio files not removed from the library. */
export const isSong = and(eq(mediaEntries.isAudio, true), isNull(mediaEntries.deletedAt));

/** The artist a song is filed under: its artist tag, or its album artist when that is all it has. */
function filedArtist(row: { artist: string | null; albumArtist: string | null }) {
  return row.artist?.trim() || row.albumArtist?.trim() || null;
}

/**
 * One key for every spelling of an artist: "Röyksopp" and "Royksopp", "AC/DC" and "ACDC", or
 * "The Art of Noise" and "Art of Noise, The".
 */
function artistKey(name: string) {
  return normalizeArtist(name) || name.trim().toLowerCase();
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Letters outside ASCII, such as accents: of two spellings, the one with more is usually the right one. */
const nonAscii = (text: string) => text.replace(/[\x00-\x7f]/g, '').length;

/** The spelling most of an artist's songs use; on a tie, the one with accents, then the first in code point order. */
function commonSpelling(spellings: Map<string, number>) {
  return [...spellings].sort(
    ([a, left], [b, right]) => right - left || nonAscii(b) - nonAscii(a) || (a < b ? -1 : a > b ? 1 : 0),
  )[0]![0];
}

export function findProfile(profileId: string) {
  return Effect.gen(function* () {
    const [profile] = yield* query((db) =>
      db.select({ id: profiles.id, name: profiles.name }).from(profiles).where(eq(profiles.id, profileId)).limit(1),
    );
    if (!profile) return yield* new ProfileNotFound({ id: profileId });
    return profile;
  });
}

/** Every song in the library, as matching and search read them. */
function loadCatalog() {
  return query((db) =>
    db
      .select(trackColumns)
      .from(mediaEntries)
      .innerJoin(mediaRoots, eq(mediaRoots.id, mediaEntries.mediaRootId))
      .where(isSong),
  ).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ ...row, folders: breadcrumb(row.rootName, row.relativePath).slice(0, -1) })),
    ),
  );
}

/** The library's best match for each requested song, in request order. */
export function matchTracks(requests: readonly TrackQuery[]) {
  return loadCatalog().pipe(
    Effect.map((catalog) => {
      const matcher = new TrackMatcher(catalog);
      return {
        matches: requests.map((request) => {
          const { confidence, match, alternatives } = matcher.match(request);
          return {
            request: { title: request.title, artist: request.artist ?? null, album: request.album ?? null },
            confidence,
            match: match && toTrack(match),
            alternatives: alternatives.map(toTrack),
          };
        }),
      };
    }),
  );
}

type SearchOptions = { artist?: string; album?: string; limit: number };

/**
 * Songs where every word of `text` occurs in the title, artist, album, or file path, ignoring case
 * and accents. `artist` and `album` narrow the results to songs credited that way.
 */
export function searchTracks(text: string, options: SearchOptions) {
  const words = normalizeText(text).split(' ').filter(Boolean);
  const artist = options.artist ? normalizeArtist(options.artist) : null;
  const album = options.album ? normalizeText(options.album) : null;
  return loadCatalog().pipe(
    Effect.map((catalog) => {
      const found = catalog.flatMap((row) => {
        const title = normalizeText(row.title ?? fileTitle(row.name));
        const trackArtist = normalizeText(row.artist ?? '');
        const albumArtist = normalizeText(row.albumArtist ?? '');
        const albumName = normalizeText(row.album ?? '');
        const path = normalizeText(row.relativePath);
        if (
          artist &&
          !normalizeArtist(row.artist ?? '').includes(artist) &&
          !normalizeArtist(row.albumArtist ?? '').includes(artist)
        ) {
          return [];
        }
        if (album && !albumName.includes(album)) return [];
        const everything = `${title} ${trackArtist} ${albumArtist} ${albumName} ${path}`;
        if (!words.every((word) => everything.includes(word))) return [];
        // A word in the title or the song's artist counts most, then one in the album or album
        // artist (such as a compilation the artist put together); one only in a folder name counts nothing.
        const relevance = words.reduce(
          (total, word) =>
            total +
            (title.includes(word) || trackArtist.includes(word)
              ? 2
              : albumName.includes(word) || albumArtist.includes(word)
                ? 1
                : 0),
          0,
        );
        return [{ row, relevance }];
      });
      found.sort(
        (left, right) =>
          right.relevance - left.relevance ||
          collator.compare(left.row.artist ?? '', right.row.artist ?? '') ||
          collator.compare(left.row.album ?? '', right.row.album ?? '') ||
          (left.row.trackNumber ?? Infinity) - (right.row.trackNumber ?? Infinity) ||
          collator.compare(left.row.relativePath, right.row.relativePath),
      );
      return { total: found.length, results: found.slice(0, options.limit).map(({ row }) => toTrack(row)) };
    }),
  );
}

type Plays = Map<string, { playCount: number; lastPlayedAt: Date }>;

/** How often the profile played each song (every song, or those in `trackIds`), keyed by song ID. */
export function playCounts(profileId: string, trackIds?: readonly string[]) {
  if (trackIds && !trackIds.length) return Effect.succeed<Plays>(new Map());
  return query((db) =>
    db
      .select({
        mediaEntryId: trackPlays.mediaEntryId,
        playCount: sql<number>`count(*)::int`,
        lastPlayedAt: sql<Date>`max(${trackPlays.playedAt})`.mapWith(trackPlays.playedAt),
      })
      .from(trackPlays)
      .where(
        and(
          eq(trackPlays.profileId, profileId),
          trackIds ? inArray(trackPlays.mediaEntryId, [...trackIds]) : undefined,
        ),
      )
      .groupBy(trackPlays.mediaEntryId),
  ).pipe(Effect.map((rows): Plays => new Map(rows.map(({ mediaEntryId, ...plays }) => [mediaEntryId, plays]))));
}

export function withPlays(tracks: readonly Track[], plays: Plays) {
  return tracks.map((track): TrackWithPlays => {
    const played = plays.get(track.id);
    return { ...track, playCount: played?.playCount ?? 0, lastPlayedAt: played?.lastPlayedAt.toISOString() ?? null };
  });
}

type ArtistSort = 'name' | 'tracks' | 'plays';
type ArtistOptions = { query?: string; sort: ArtistSort; limit: number; offset: number };

type ArtistSummary = {
  name: string;
  trackCount: number;
  albumCount: number;
  playCount: number;
  lastPlayedAt: string | null;
};

/**
 * The library's artists, from song tags: each with its songs, albums, and the profile's plays.
 * Spellings that differ only in case, accents, or punctuation are one artist. Songs without an
 * artist or album artist tag are only counted in `tracksWithoutArtist`.
 */
export function listArtists(profileId: string, options: ArtistOptions) {
  return Effect.gen(function* () {
    const profile = yield* findProfile(profileId);
    const [catalog, plays] = yield* Effect.all([loadCatalog(), playCounts(profileId)], { concurrency: 2 });
    const groups = new Map<
      string,
      { spellings: Map<string, number>; tracks: number; albums: Set<string>; plays: number; lastPlayed: Date | null }
    >();
    let tracksWithoutArtist = 0;
    for (const row of catalog) {
      const name = filedArtist(row);
      if (!name) {
        tracksWithoutArtist++;
        continue;
      }
      const key = artistKey(name);
      const group = groups.get(key) ?? {
        spellings: new Map(),
        tracks: 0,
        albums: new Set(),
        plays: 0,
        lastPlayed: null,
      };
      group.spellings.set(name, (group.spellings.get(name) ?? 0) + 1);
      group.tracks++;
      if (row.album?.trim()) group.albums.add(normalizeText(row.album));
      const played = plays.get(row.id);
      if (played) {
        group.plays += played.playCount;
        if (!group.lastPlayed || played.lastPlayedAt > group.lastPlayed) group.lastPlayed = played.lastPlayedAt;
      }
      groups.set(key, group);
    }
    // Compared with artist keys, so "The Beatles" finds "Beatles, The" as grouping does.
    const filter = options.query ? artistKey(options.query) : '';
    const artists = [...groups]
      .filter(([key]) => key.includes(filter))
      .map(([, group]): ArtistSummary => ({
        name: commonSpelling(group.spellings),
        trackCount: group.tracks,
        albumCount: group.albums.size,
        playCount: group.plays,
        lastPlayedAt: group.lastPlayed?.toISOString() ?? null,
      }));
    const byName = (left: ArtistSummary, right: ArtistSummary) => collator.compare(left.name, right.name);
    const order: Record<ArtistSort, (left: ArtistSummary, right: ArtistSummary) => number> = {
      name: byName,
      tracks: (left, right) => right.trackCount - left.trackCount || byName(left, right),
      plays: (left, right) => right.playCount - left.playCount || byName(left, right),
    };
    artists.sort(order[options.sort]);
    return {
      profile,
      totalArtists: artists.length,
      tracksWithoutArtist,
      artists: artists.slice(options.offset, options.offset + options.limit),
    };
  });
}

/**
 * One artist's songs, grouped by album, with the profile's plays: songs filed under the artist or
 * with them as album artist. The name matches ignoring case, accents, and punctuation.
 */
export function getArtist(profileId: string, name: string) {
  return Effect.gen(function* () {
    const profile = yield* findProfile(profileId);
    const key = artistKey(name);
    const catalog = yield* loadCatalog();
    const spellings = new Map<string, number>();
    const rows = catalog.filter((row) => {
      const filed = filedArtist(row);
      if (filed && artistKey(filed) === key) {
        spellings.set(filed, (spellings.get(filed) ?? 0) + 1);
        return true;
      }
      return Boolean(row.albumArtist && artistKey(row.albumArtist) === key);
    });
    if (!rows.length) return yield* new ArtistNotFound({ name });
    rows.sort(
      (left, right) =>
        Number(!left.album) - Number(!right.album) ||
        collator.compare(left.album ?? '', right.album ?? '') ||
        (left.trackNumber ?? Infinity) - (right.trackNumber ?? Infinity) ||
        collator.compare(left.relativePath, right.relativePath),
    );
    const tracks = rows.slice(0, ARTIST_TRACK_LIMIT).map(toTrack);
    const plays = yield* playCounts(
      profileId,
      tracks.map((track) => track.id),
    );
    const albums = new Map<string, { album: string | null; tracks: TrackWithPlays[] }>();
    for (const track of withPlays(tracks, plays)) {
      const albumKey = track.album ? normalizeText(track.album) : '';
      const album = albums.get(albumKey) ?? { album: track.album, tracks: [] };
      album.tracks.push(track);
      albums.set(albumKey, album);
    }
    return {
      profile,
      artist: spellings.size ? commonSpelling(spellings) : rows[0]!.albumArtist!.trim(),
      trackCount: tracks.length,
      truncated: rows.length > ARTIST_TRACK_LIMIT,
      albums: [...albums.values()],
    };
  });
}

type StatsOptions = { days?: number; limit: number };

/** The most-played artists, from per-song play counts. */
function topArtists(
  played: readonly { artist: string | null; albumArtist: string | null; playCount: number }[],
  limit: number,
) {
  const groups = new Map<string, { spellings: Map<string, number>; plays: number; tracks: number }>();
  for (const track of played) {
    const name = filedArtist(track);
    if (!name) continue;
    const key = artistKey(name);
    const group = groups.get(key) ?? { spellings: new Map(), plays: 0, tracks: 0 };
    group.spellings.set(name, (group.spellings.get(name) ?? 0) + 1);
    group.plays += track.playCount;
    group.tracks++;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ name: commonSpelling(group.spellings), playCount: group.plays, trackCount: group.tracks }))
    .sort((left, right) => right.playCount - left.playCount || collator.compare(left.name, right.name))
    .slice(0, limit);
}

/** What the profile listens to: totals, most-played songs and artists, and recent plays. */
export function getListeningStats(profileId: string, options: StatsOptions) {
  return Effect.gen(function* () {
    const profile = yield* findProfile(profileId);
    const since = options.days ? new Date(Date.now() - options.days * 86_400_000) : undefined;
    const inWindow = and(
      eq(trackPlays.profileId, profileId),
      since ? gte(trackPlays.playedAt, since) : undefined,
      isSong,
    );
    const [[totals], topTracks, playedTracks, recent] = yield* Effect.all(
      [
        query((db) =>
          db
            .select({
              plays: sql<number>`count(*)::int`,
              tracks: sql<number>`count(distinct ${trackPlays.mediaEntryId})::int`,
              playedDurationMs: sql<number>`coalesce(sum(${mediaEntries.durationMs}), 0)`.mapWith(Number),
            })
            .from(trackPlays)
            .innerJoin(mediaEntries, eq(mediaEntries.id, trackPlays.mediaEntryId))
            .where(inWindow),
        ),
        query((db) =>
          db
            .select({
              ...trackColumns,
              playCount: sql<number>`count(*)::int`,
              lastPlayedAt: sql<Date>`max(${trackPlays.playedAt})`.mapWith(trackPlays.playedAt),
            })
            .from(trackPlays)
            .innerJoin(mediaEntries, eq(mediaEntries.id, trackPlays.mediaEntryId))
            .innerJoin(mediaRoots, eq(mediaRoots.id, mediaEntries.mediaRootId))
            .where(inWindow)
            .groupBy(mediaEntries.id, mediaRoots.id)
            .orderBy(desc(sql`count(*)`), desc(sql`max(${trackPlays.playedAt})`))
            .limit(options.limit),
        ),
        query((db) =>
          db
            .select({
              artist: mediaEntries.artist,
              albumArtist: mediaEntries.albumArtist,
              playCount: sql<number>`count(*)::int`,
            })
            .from(trackPlays)
            .innerJoin(mediaEntries, eq(mediaEntries.id, trackPlays.mediaEntryId))
            .where(inWindow)
            .groupBy(mediaEntries.id),
        ),
        query((db) =>
          db
            .select({ ...trackColumns, playedAt: trackPlays.playedAt })
            .from(trackPlays)
            .innerJoin(mediaEntries, eq(mediaEntries.id, trackPlays.mediaEntryId))
            .innerJoin(mediaRoots, eq(mediaRoots.id, mediaEntries.mediaRootId))
            .where(inWindow)
            .orderBy(desc(trackPlays.playedAt))
            .limit(options.limit),
        ),
      ],
      { concurrency: 4 },
    );
    return {
      profile,
      since: since?.toISOString() ?? null,
      totalPlays: totals?.plays ?? 0,
      distinctTracks: totals?.tracks ?? 0,
      // Each play counts the song's full length, so this overstates songs cut short.
      playedDurationMs: totals?.playedDurationMs ?? 0,
      topTracks: topTracks.map((row) => ({
        ...toTrack(row),
        playCount: row.playCount,
        lastPlayedAt: row.lastPlayedAt.toISOString(),
      })),
      topArtists: topArtists(playedTracks, options.limit),
      recentPlays: recent.map((row) => ({ ...toTrack(row), playedAt: row.playedAt.toISOString() })),
    };
  });
}
