import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PLAYLIST_NAME_MAX_LENGTH } from '$lib/shared/contracts/music';
import { getArtist, getListeningStats, listArtists, matchTracks, searchTracks } from '$lib/server/mcp/music';
import { addToPlaylist, createPlaylist, getPlaylist, listPlaylists, reorderPlaylist } from '$lib/server/mcp/playlists';
import type { ToolRunner } from '$lib/server/mcp/server';

/** The most songs one `match_tracks` call looks up. */
const MATCH_LIMIT = 200;

/** The most tracks one call adds to a playlist. */
const APPEND_LIMIT = 1_000;

/** The longest playlist `reorder_playlist` orders in one call. */
const REORDER_LIMIT = 10_000;

const profileSchema = z.object({ id: z.string().uuid(), name: z.string() });

const trackSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  albumArtist: z.string().nullable(),
  trackNumber: z.number().int().nullable(),
  durationMs: z.number().nullable(),
  breadcrumb: z.array(z.string()),
});

const trackWithPlaysSchema = trackSchema.extend({
  playCount: z.number().int(),
  lastPlayedAt: z.string().nullable(),
});

const trackIdsSchema = z.array(z.string().uuid()).max(APPEND_LIMIT);

/** What adding tracks to a playlist did with each requested ID. */
const appendResultSchema = {
  added: z.array(z.string().uuid()),
  alreadyInPlaylist: z.array(z.string().uuid()),
  notFound: z.array(z.string().uuid()),
};

const playlistSummarySchema = z.object({ id: z.string().uuid(), name: z.string(), trackCount: z.number().int() });

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function result<T extends Record<string, unknown>>(structuredContent: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }], structuredContent };
}

export function registerMusicTools(server: McpServer, run: ToolRunner) {
  server.registerTool(
    'match_tracks',
    {
      title: 'Find songs in the music library',
      description:
        'Look up a list of songs (title, optional artist and album) in the music library, such as a tracklist to turn into a playlist. ' +
        'Matching ignores case, accents, punctuation, and qualifiers like "(Remastered 2011)" or "feat. X", and uses file and folder names when tags are missing. ' +
        'Each result has a confidence: "exact" and "likely" matches can be used as they are; confirm "ambiguous" ones (another version, another artist, or a close tie) using the alternatives; "none" means the library does not have the song. ' +
        'Pass the matched IDs to create_playlist or add_to_playlist.',
      inputSchema: {
        tracks: z
          .array(
            z.object({
              title: z.string().trim().min(1).max(300),
              artist: z.string().trim().max(300).optional(),
              album: z.string().trim().max(300).optional(),
            }),
          )
          .min(1)
          .max(MATCH_LIMIT),
      },
      outputSchema: {
        matches: z.array(
          z.object({
            request: z.object({ title: z.string(), artist: z.string().nullable(), album: z.string().nullable() }),
            confidence: z.enum(['exact', 'likely', 'ambiguous', 'none']),
            match: trackSchema.nullable(),
            alternatives: z.array(trackSchema),
          }),
        ),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ tracks }) => result(await run(matchTracks(tracks))),
  );

  server.registerTool(
    'search_tracks',
    {
      title: 'Search the music library',
      description:
        'Search songs by words. Every word must occur in the title, artist, album, or file path; case and accents are ignored. ' +
        'Narrow with artist or album (each matches part of the name). Songs whose title or artist contains the words come first.',
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        artist: z.string().trim().min(1).max(200).optional(),
        album: z.string().trim().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      },
      outputSchema: { total: z.number().int(), results: z.array(trackSchema) },
      annotations: readOnlyAnnotations,
    },
    async ({ query, artist, album, limit }) => result(await run(searchTracks(query, { artist, album, limit }))),
  );

  server.registerTool(
    'list_artists',
    {
      title: 'List artists in the music library',
      description:
        'List the artists in the music library with their track and album counts and how often the profile played them. ' +
        'Use it to see what the library holds before suggesting songs. Artists come from artist tags (or album artist tags); ' +
        'songs with neither are counted in tracksWithoutArtist and can be found with search_tracks. Sort by name, tracks, or plays; page with offset.',
      inputSchema: {
        profileId: z.string().uuid(),
        query: z.string().trim().min(1).max(200).optional(),
        sort: z.enum(['name', 'tracks', 'plays']).default('name'),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      outputSchema: {
        profile: profileSchema,
        totalArtists: z.number().int(),
        tracksWithoutArtist: z.number().int(),
        artists: z.array(
          z.object({
            name: z.string(),
            trackCount: z.number().int(),
            albumCount: z.number().int(),
            playCount: z.number().int(),
            lastPlayedAt: z.string().nullable(),
          }),
        ),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ profileId, ...options }) => result(await run(listArtists(profileId, options))),
  );

  server.registerTool(
    'get_artist',
    {
      title: 'Get an artist’s songs',
      description:
        'List one artist’s songs in the music library, grouped by album, with the profile’s play counts. ' +
        'The name must match an artist or album artist tag exactly, ignoring case; use a name from list_artists.',
      inputSchema: { profileId: z.string().uuid(), name: z.string().trim().min(1).max(300) },
      outputSchema: {
        profile: profileSchema,
        artist: z.string(),
        trackCount: z.number().int(),
        truncated: z.boolean(),
        albums: z.array(z.object({ album: z.string().nullable(), tracks: z.array(trackWithPlaysSchema) })),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ profileId, name }) => result(await run(getArtist(profileId, name))),
  );

  server.registerTool(
    'list_playlists',
    {
      title: 'List playlists',
      description: 'List a profile’s playlists, oldest first, with their track counts and total length.',
      inputSchema: { profileId: z.string().uuid() },
      outputSchema: {
        profile: profileSchema,
        playlists: z.array(
          z.object({
            id: z.string().uuid(),
            name: z.string(),
            trackCount: z.number().int(),
            durationMs: z.number(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
        ),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ profileId }) => result(await run(listPlaylists(profileId))),
  );

  server.registerTool(
    'get_playlist',
    {
      title: 'Get a playlist',
      description:
        'Get a playlist’s songs in order, with how often the profile played each. Read it before suggesting additions.',
      inputSchema: { profileId: z.string().uuid(), playlistId: z.string().uuid() },
      outputSchema: {
        profile: profileSchema,
        playlist: z.object({
          id: z.string().uuid(),
          name: z.string(),
          trackCount: z.number().int(),
          durationMs: z.number(),
        }),
        tracks: z.array(trackWithPlaysSchema),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ profileId, playlistId }) => result(await run(getPlaylist(profileId, playlistId))),
  );

  server.registerTool(
    'create_playlist',
    {
      title: 'Create a playlist',
      description:
        'Create a playlist for a profile, optionally filled with tracks (IDs from match_tracks, search_tracks, or get_artist) in the given order. ' +
        'Duplicate IDs are added once; IDs that are not songs in the library are listed in notFound.',
      inputSchema: {
        profileId: z.string().uuid(),
        name: z.string().trim().min(1).max(PLAYLIST_NAME_MAX_LENGTH),
        trackIds: trackIdsSchema.default([]),
      },
      outputSchema: { profile: profileSchema, playlist: playlistSummarySchema, ...appendResultSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ profileId, name, trackIds }) => result(await run(createPlaylist(profileId, name, trackIds))),
  );

  server.registerTool(
    'add_to_playlist',
    {
      title: 'Add tracks to a playlist',
      description:
        'Append tracks to the end of one of the profile’s playlists, in the given order. ' +
        'Tracks already in the playlist are skipped (alreadyInPlaylist); IDs that are not songs in the library are listed in notFound.',
      inputSchema: {
        profileId: z.string().uuid(),
        playlistId: z.string().uuid(),
        trackIds: trackIdsSchema.min(1),
      },
      outputSchema: { profile: profileSchema, playlist: playlistSummarySchema, ...appendResultSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ profileId, playlistId, trackIds }) => result(await run(addToPlaylist(profileId, playlistId, trackIds))),
  );

  server.registerTool(
    'reorder_playlist',
    {
      title: 'Reorder a playlist',
      description:
        'Put one of the profile’s playlists in a new order. trackIds must list every track in the playlist, as get_playlist returns them, exactly once; ' +
        'to move a few tracks, read the playlist and send its whole order with them moved. The result is the playlist’s new order.',
      inputSchema: {
        profileId: z.string().uuid(),
        playlistId: z.string().uuid(),
        trackIds: z.array(z.string().uuid()).min(1).max(REORDER_LIMIT),
      },
      outputSchema: { profile: profileSchema, playlist: playlistSummarySchema, trackIds: z.array(z.string().uuid()) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ profileId, playlistId, trackIds }) => result(await run(reorderPlaylist(profileId, playlistId, trackIds))),
  );

  server.registerTool(
    'get_listening_stats',
    {
      title: 'Get listening stats',
      description:
        'Summarize what a profile listens to: total plays, most-played tracks and artists, and recent plays. ' +
        'A play is recorded when half a song (or four minutes of it) has been listened to. Set days to look at a recent window; omit it for all time.',
      inputSchema: {
        profileId: z.string().uuid(),
        days: z.number().int().min(1).max(3650).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
      outputSchema: {
        profile: profileSchema,
        since: z.string().nullable(),
        totalPlays: z.number().int(),
        distinctTracks: z.number().int(),
        playedDurationMs: z.number(),
        topTracks: z.array(trackSchema.extend({ playCount: z.number().int(), lastPlayedAt: z.string() })),
        topArtists: z.array(z.object({ name: z.string(), playCount: z.number().int(), trackCount: z.number().int() })),
        recentPlays: z.array(trackSchema.extend({ playedAt: z.string() })),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ profileId, days, limit }) => result(await run(getListeningStats(profileId, { days, limit }))),
  );
}
