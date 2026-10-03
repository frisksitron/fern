import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Effect } from 'effect';
import { z } from 'zod';
import type { Database, DatabaseUnavailable } from '$lib/server/db/service';
import type { PlaylistNotFound, ProfileNotFound } from '$lib/server/library/errors';
import { listProfiles } from '$lib/server/library/profiles';
import { getDirectoryProgress, searchLibrary, type DirectoryNotFound } from '$lib/server/mcp/library';
import type { ArtistNotFound } from '$lib/server/mcp/music';
import { registerMusicTools } from '$lib/server/mcp/music-tools';
import type { PlaylistOrderMismatch } from '$lib/server/mcp/playlists';

/** The failures a tool can report; each becomes an error result with a readable message. */
type ToolFailure =
  DatabaseUnavailable | ProfileNotFound | DirectoryNotFound | PlaylistNotFound | ArtistNotFound | PlaylistOrderMismatch;

/** Runs a tool's program for the current request. */
export type ToolRunner = <A>(program: Effect.Effect<A, ToolFailure, Database.Service>) => Promise<A>;

export function toolFailureMessage(error: ToolFailure) {
  switch (error._tag) {
    case 'DatabaseUnavailable':
      return 'The library database is unavailable.';
    case 'ProfileNotFound':
      return 'Profile not found';
    case 'DirectoryNotFound':
      return 'Directory not found';
    case 'PlaylistNotFound':
      return 'Playlist not found for this profile';
    case 'ArtistNotFound':
      return 'No songs are tagged with that artist; use list_artists or search_tracks to find the name';
    case 'PlaylistOrderMismatch':
      return orderMismatchMessage(error);
  }
}

function orderMismatchMessage({ missing, unknown, repeated }: PlaylistOrderMismatch) {
  const problems = [
    missing.length ? `missing: ${missing.join(', ')}` : '',
    unknown.length ? `not in the playlist: ${unknown.join(', ')}` : '',
    repeated.length ? `listed more than once: ${repeated.join(', ')}` : '',
  ].filter(Boolean);
  return `trackIds must list every track in the playlist exactly once (see get_playlist); ${problems.join('; ')}`;
}

const profileSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

const breadcrumbSchema = z.array(z.string());
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function createMcpServer(run: ToolRunner): McpServer {
  const server = new McpServer({ name: 'fern', version: '1.0.0' });

  server.registerTool(
    'list_profiles',
    {
      title: 'List Fern profiles',
      description: 'List the viewer profiles configured in Fern.',
      outputSchema: { profiles: z.array(profileSchema) },
      annotations: readOnlyAnnotations,
    },
    async () => {
      const result = { profiles: await run(listProfiles()) };

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    'search_library',
    {
      title: 'Search the Fern library',
      description:
        'Search video files and directories in Fern (for songs, use search_tracks or match_tracks). Every word must occur somewhere in the library-relative path. Results include stable IDs and breadcrumbs for use with other tools.',
      inputSchema: {
        query: z.string().trim().min(1).max(200),
        kind: z.enum(['file', 'directory']).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
      outputSchema: {
        results: z.array(
          z.object({
            id: z.string().uuid(),
            name: z.string(),
            kind: z.enum(['file', 'directory']),
            mediaRootId: z.string().uuid(),
            rootName: z.string(),
            breadcrumb: breadcrumbSchema,
            durationMs: z.number().nullable(),
          }),
        ),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ query, kind, limit }) => {
      const result = await run(searchLibrary(query, kind, limit));
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    'get_directory_progress',
    {
      title: 'Get viewing progress for a directory',
      description:
        'Summarize watched, in-progress, unstarted, and remaining videos in a Fern directory for one profile. Set recursive to include videos in nested directories.',
      inputSchema: {
        profileId: z.string().uuid(),
        directoryId: z.string().uuid(),
        recursive: z.boolean().default(false),
      },
      outputSchema: {
        profile: profileSchema,
        directory: z.object({
          id: z.string().uuid(),
          name: z.string(),
          mediaRootId: z.string().uuid(),
          rootName: z.string(),
          breadcrumb: breadcrumbSchema,
        }),
        recursive: z.boolean(),
        totalVideos: z.number().int(),
        watchedVideos: z.number().int(),
        inProgressVideos: z.number().int(),
        unstartedVideos: z.number().int(),
        remainingVideos: z.number().int(),
        durationKnownVideos: z.number().int(),
        remainingDurationMs: z.number(),
        nextVideo: z
          .object({
            id: z.string().uuid(),
            name: z.string(),
            breadcrumb: breadcrumbSchema,
            durationMs: z.number().nullable(),
            positionMs: z.number(),
          })
          .nullable(),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ profileId, directoryId, recursive }) => {
      const result = await run(getDirectoryProgress(profileId, directoryId, recursive));
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  registerMusicTools(server, run);

  return server;
}
