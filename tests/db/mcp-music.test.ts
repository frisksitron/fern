import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { zeroNodePg } from '@rocicorp/zero/server/adapters/pg';
import { expect, layer } from '@effect/vitest';
import { Cause, Context, Effect, Exit, Layer, Option } from 'effect';
import { SqlClient } from 'effect/sql';
import pg from 'pg';
import type { Database } from '../../src/lib/server/db/service';
import { createMcpServer, toolFailureMessage, type ToolRunner } from '../../src/lib/server/mcp/server';
import { mutators } from '../../src/lib/zero/mutators';
import { schema as zeroSchema } from '../../src/lib/zero/schema';
import { TestDatabase } from './support/database';

const profileId = randomUUID();
const otherProfileId = randomUUID();
const musicRoot = randomUUID();

type Seeded = { id: string; title: string | null; artist: string | null; album: string | null };

/** The library the tests share, and an MCP client connected to Fern's MCP server over it. */
class Mcp extends Context.Service<
  Mcp,
  {
    readonly songs: Readonly<Record<string, Seeded>>;
    readonly toolNames: () => Effect.Effect<string[]>;
    /** Calls a tool; an error result fails with its message. */
    readonly call: <T = Record<string, unknown>>(
      name: string,
      args: Record<string, unknown>,
    ) => Effect.Effect<T, Error>;
  }
>()('test/Mcp') {}

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const songs: Record<string, Seeded> = {};
  const addSong = Effect.fnUntraced(function* (
    key: string,
    path: string,
    tags: Partial<Omit<Seeded, 'id'>> & { trackNumber?: number },
  ) {
    const id = randomUUID();
    const name = path.split('/').at(-1)!;
    yield* sql`insert into media_entries (id, media_root_id, relative_path, name, kind, mtime_ms, is_audio, duration_ms,
        title, artist, album, track_number, probe_status)
      values (${id}, ${musicRoot}, ${path}, ${name}, 'file', 0, true, 200000, ${tags.title ?? null},
        ${tags.artist ?? null}, ${tags.album ?? null}, ${tags.trackNumber ?? null}, 'ok')`;
    songs[key] = { id, title: tags.title ?? null, artist: tags.artist ?? null, album: tags.album ?? null };
    return id;
  });
  const play = (key: string, times: number, daysAgo: number) =>
    Effect.forEach(
      Array.from({ length: times }),
      () => sql`insert into track_plays (id, profile_id, media_entry_id, played_at)
        values (${randomUUID()}, ${profileId}, ${songs[key]!.id}, now() - make_interval(days => ${daysAgo}))`,
      { discard: true },
    );

  yield* sql`insert into profiles (id, name, avatar_key)
    values (${profileId}, 'Listener', 'fern'), (${otherProfileId}, 'Someone else', 'fern')`;
  yield* sql`insert into media_roots (id, path, display_name, media_type)
    values (${musicRoot}, '/library/music', 'Music', 'music')`;
  yield* addSong('heyJude', 'Beatles/1/01 Hey Jude.flac', {
    title: 'Hey Jude - Remastered 2015',
    artist: 'The Beatles',
    album: '1',
    trackNumber: 1,
  });
  yield* addSong('letItBe', 'Beatles/Let It Be/06 Let It Be.flac', {
    title: 'Let It Be',
    artist: 'The Beatles',
    album: 'Let It Be',
    trackNumber: 6,
  });
  yield* addSong('joga', 'Björk/Homogenic/03 Jóga.flac', {
    title: 'Jóga',
    artist: 'Björk',
    album: 'Homogenic',
    trackNumber: 3,
  });
  // The same artist spelled without the accent is still one artist.
  yield* addSong('hunter', 'Björk/Homogenic/01 Hunter.flac', {
    title: 'Hunter',
    artist: 'Bjork',
    album: 'Homogenic',
    trackNumber: 1,
  });
  yield* addSong('teardrop', 'Massive Attack/Mezzanine/03 - Teardrop.mp3', {});
  yield* addSong('legs', 'Art of Noise/Legs.flac', { title: 'Legs', artist: 'Art Of Noise, The' });
  const removed = yield* addSong('removed', 'Gone/Gone.flac', { title: 'Gone', artist: 'Nobody' });
  yield* sql`update media_entries set deleted_at = now() where id = ${removed}`;

  yield* play('joga', 3, 1);
  yield* play('hunter', 1, 1);
  yield* play('letItBe', 2, 100);
  return songs;
}).pipe(Effect.orDie);

const McpLayer = Layer.effect(
  Mcp,
  Effect.gen(function* () {
    const songs = yield* seed;
    // Runs tools on the test database, reporting typed failures as the /mcp route does.
    const services = yield* Effect.context<Database.Service>();
    const run: ToolRunner = async (program) => {
      const exit = await Effect.runPromiseWith(services)(Effect.exit(program));
      if (Exit.isSuccess(exit)) return exit.value;
      const failure = Cause.findErrorOption(exit.cause);
      throw new Error(Option.isSome(failure) ? toolFailureMessage(failure.value) : 'Something went wrong.');
    };
    const client = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const server = createMcpServer(run);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const connected = new Client({ name: 'fern-test', version: '1.0.0' });
        await connected.connect(clientTransport);
        // Listing tools lets the client check every result against the tool's output schema.
        await connected.listTools();
        return connected;
      }),
      (connected) => Effect.promise(() => connected.close()),
    );
    const call = <T = Record<string, unknown>>(name: string, args: Record<string, unknown>) =>
      Effect.tryPromise({
        try: async () => {
          const result = await client.callTool({ name, arguments: args });
          if (result.isError) throw new Error((result.content as { text: string }[])[0]?.text);
          return result.structuredContent as T;
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
    const toolNames = () =>
      Effect.promise(() => client.listTools()).pipe(Effect.map(({ tools }) => tools.map((tool) => tool.name)));
    return { songs, call, toolNames };
  }),
);

/** Node-postgres on the test database, for Zero's server transactions. */
const zeroPool = Effect.acquireRelease(
  Effect.map(TestDatabase.Service, (database) => new pg.Pool({ connectionString: database.url, max: 5 })),
  (pool) => Effect.promise(() => pool.end()),
);

const itemsOf = (playlistId: string) =>
  SqlClient.SqlClient.use(
    (sql) => sql<{ media_entry_id: string; position: number }>`select media_entry_id, position from playlist_items
      where playlist_id = ${playlistId} order by position`,
  );

type Match = { confidence: string; match: { id: string; title: string } | null };
type AppendResult = {
  playlist: { id: string; name: string; trackCount: number };
  added: string[];
  alreadyInPlaylist: string[];
  notFound: string[];
};

layer(McpLayer.pipe(Layer.provideMerge(TestDatabase.layer)), { excludeTestServices: true })('MCP music tools', (it) => {
  it.effect('offer the music tools', () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      expect(yield* mcp.toolNames()).toEqual(
        expect.arrayContaining([
          'match_tracks',
          'search_tracks',
          'list_artists',
          'get_artist',
          'list_playlists',
          'get_playlist',
          'create_playlist',
          'add_to_playlist',
          'get_listening_stats',
          'reorder_playlist',
        ]),
      );
    }),
  );

  it.effect('turn a tracklist into a playlist', () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const { matches } = yield* mcp.call<{ matches: Match[] }>('match_tracks', {
        tracks: [
          { title: 'Hey Jude', artist: 'Beatles' },
          { title: 'Joga', artist: 'Bjork' },
          { title: 'Teardrop', artist: 'Massive Attack' },
          { title: 'Gone', artist: 'Nobody' },
          { title: 'Bohemian Rhapsody', artist: 'Queen' },
        ],
      });
      expect(matches.map((match) => [match.confidence, match.match?.id ?? null])).toEqual([
        ['exact', mcp.songs.heyJude!.id],
        ['exact', mcp.songs.joga!.id],
        ['exact', mcp.songs.teardrop!.id],
        ['none', null],
        ['none', null],
      ]);
      // Untagged songs are named after their file.
      expect(matches[2]!.match!.title).toBe('Teardrop');

      const found = matches.flatMap((match) => (match.match ? [match.match.id] : []));
      const missing = randomUUID();
      const created = yield* mcp.call<AppendResult>('create_playlist', {
        profileId,
        name: '  Road trip  ',
        trackIds: [...found, found[0], missing, mcp.songs.removed!.id],
      });
      expect(created).toMatchObject({
        playlist: { name: 'Road trip', trackCount: 3 },
        added: found,
        alreadyInPlaylist: [],
        notFound: [missing, mcp.songs.removed!.id],
      });

      const { playlist, tracks } = yield* mcp.call<{
        playlist: { trackCount: number; durationMs: number };
        tracks: { id: string; playCount: number }[];
      }>('get_playlist', { profileId, playlistId: created.playlist.id });
      expect(tracks.map((track) => track.id)).toEqual(found);
      expect(tracks.map((track) => track.playCount)).toEqual([0, 3, 0]);
      expect(playlist).toMatchObject({ trackCount: 3, durationMs: 600_000 });

      const { playlists } = yield* mcp.call<{ playlists: { id: string; trackCount: number }[] }>('list_playlists', {
        profileId,
      });
      expect(playlists).toEqual([expect.objectContaining({ id: created.playlist.id, trackCount: 3 })]);
    }),
  );

  it.effect('append to a playlist after its last item, skipping songs it holds', () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const sql = yield* SqlClient.SqlClient;
      const created = yield* mcp.call<AppendResult>('create_playlist', {
        profileId,
        name: 'Mix',
        trackIds: [mcp.songs.heyJude!.id, mcp.songs.letItBe!.id],
      });
      // Removing the first item leaves a gap in positions.
      yield* sql`delete from playlist_items
      where playlist_id = ${created.playlist.id} and media_entry_id = ${mcp.songs.heyJude!.id}`;
      // A song removed from the library stays in the playlist but is not counted.
      yield* sql`insert into playlist_items (id, playlist_id, media_entry_id, position)
      values (${randomUUID()}, ${created.playlist.id}, ${mcp.songs.removed!.id}, 5)`;
      const added = yield* mcp.call<AppendResult>('add_to_playlist', {
        profileId,
        playlistId: created.playlist.id,
        trackIds: [mcp.songs.letItBe!.id, mcp.songs.hunter!.id, mcp.songs.joga!.id],
      });
      expect(added).toMatchObject({
        playlist: { name: 'Mix', trackCount: 3 },
        added: [mcp.songs.hunter!.id, mcp.songs.joga!.id],
        alreadyInPlaylist: [mcp.songs.letItBe!.id],
        notFound: [],
      });
      const items = yield* itemsOf(created.playlist.id);
      expect(items.map((row) => row.position)).toEqual([1, 5, 6, 7]);
    }),
  );

  it.effect('serialize appends to one playlist from Zero and from MCP', () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const created = yield* mcp.call<AppendResult>('create_playlist', { profileId, name: 'Busy' });
      const playlistId = created.playlist.id;
      const ids = ['heyJude', 'letItBe', 'joga', 'hunter', 'teardrop'].map((key) => mcp.songs[key]!.id);
      // Zero's server transaction, as /api/zero/mutate runs `playlists.addTracks`.
      const zero = zeroNodePg(zeroSchema, yield* zeroPool);
      const zeroAppend = (mediaEntryId: string) =>
        zero.transaction((tx) =>
          mutators.playlists.addTracks.fn({
            tx,
            args: { playlistId, tracks: [{ id: randomUUID(), mediaEntryId }], now: Date.now() },
            ctx: undefined,
          } as never),
        );
      // Every song is appended twice at once, once through each path.
      yield* Effect.all(
        ids.flatMap((id, index) => [
          Effect.promise(() => zeroAppend(id)),
          mcp.call('add_to_playlist', { profileId, playlistId, trackIds: [ids[(index + 1) % ids.length]] }),
        ]),
        { concurrency: 'unbounded' },
      );
      const items = yield* itemsOf(playlistId);
      expect(items.map((row) => row.position)).toEqual([0, 1, 2, 3, 4]);
      expect(new Set(items.map((row) => row.media_entry_id))).toEqual(new Set(ids));
    }),
  );

  it.effect('reorder a playlist, keeping songs removed from the library at the end', () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const sql = yield* SqlClient.SqlClient;
      const [a, b, c] = ['heyJude', 'letItBe', 'joga'].map((key) => mcp.songs[key]!.id);
      const created = yield* mcp.call<AppendResult>('create_playlist', {
        profileId,
        name: 'Order',
        trackIds: [a, b, c],
      });
      const playlistId = created.playlist.id;
      // A removed song, which get_playlist does not show, sits between the others.
      yield* sql`update playlist_items set position = position + 1 where playlist_id = ${playlistId} and position > 0`;
      yield* sql`insert into playlist_items (id, playlist_id, media_entry_id, position)
      values (${randomUUID()}, ${playlistId}, ${mcp.songs.removed!.id}, 1)`;

      const reordered = yield* mcp.call<{ playlist: { trackCount: number }; trackIds: string[] }>('reorder_playlist', {
        profileId,
        playlistId,
        trackIds: [c, a, b],
      });
      expect(reordered).toMatchObject({ playlist: { trackCount: 3 }, trackIds: [c, a, b] });
      const { tracks } = yield* mcp.call<{ tracks: { id: string }[] }>('get_playlist', { profileId, playlistId });
      expect(tracks.map((track) => track.id)).toEqual([c, a, b]);
      expect(yield* itemsOf(playlistId)).toEqual([
        { media_entry_id: c, position: 0 },
        { media_entry_id: a, position: 1 },
        { media_entry_id: b, position: 2 },
        { media_entry_id: mcp.songs.removed!.id, position: 3 },
      ]);
    }),
  );

  it.effect('refuse an order that does not list every track exactly once, changing nothing', () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const [a, b, c] = ['heyJude', 'letItBe', 'joga'].map((key) => mcp.songs[key]!.id);
      const created = yield* mcp.call<AppendResult>('create_playlist', {
        profileId,
        name: 'Strict',
        trackIds: [a, b, c],
      });
      const playlistId = created.playlist.id;
      const refusal = (trackIds: string[], owner = profileId) =>
        Effect.flip(mcp.call('reorder_playlist', { profileId: owner, playlistId, trackIds })).pipe(
          Effect.map((error) => error.message),
        );
      const other = mcp.songs.hunter!.id;

      expect(yield* refusal([c, a])).toContain(`missing: ${b}`);
      expect(yield* refusal([c, a, b, other])).toContain(`not in the playlist: ${other}`);
      expect(yield* refusal([c, a, b, a])).toContain(`listed more than once: ${a}`);
      expect(yield* refusal([c, a, b], otherProfileId)).toBe('Playlist not found for this profile');
      const { tracks } = yield* mcp.call<{ tracks: { id: string }[] }>('get_playlist', { profileId, playlistId });
      expect(tracks.map((track) => track.id)).toEqual([a, b, c]);
    }),
  );

  it.effect('refuse playlists of other profiles and unknown profiles', () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const created = yield* mcp.call<AppendResult>('create_playlist', { profileId, name: 'Mine' });
      const elsewhere = mcp.call('add_to_playlist', {
        profileId: otherProfileId,
        playlistId: created.playlist.id,
        trackIds: [mcp.songs.joga!.id],
      });
      expect((yield* Effect.flip(elsewhere)).message).toBe('Playlist not found for this profile');
      const nobody = mcp.call('create_playlist', { profileId: randomUUID(), name: 'Nobody’s' });
      expect((yield* Effect.flip(nobody)).message).toBe('Profile not found');
      yield* Effect.flip(mcp.call('create_playlist', { profileId, name: '   ' }));
    }),
  );

  it.effect('search songs by words, ignoring accents', () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const { total, results } = yield* mcp.call<{ total: number; results: { id: string }[] }>('search_tracks', {
        query: 'bjork',
      });
      expect(total).toBe(2);
      expect(results.map((track) => track.id)).toEqual([mcp.songs.hunter!.id, mcp.songs.joga!.id]);

      const accented = yield* mcp.call<{ total: number }>('search_tracks', { query: 'jóga björk' });
      expect(accented.total).toBe(1);

      const narrowed = yield* mcp.call<{ results: { id: string }[] }>('search_tracks', {
        query: 'let',
        artist: 'beatles',
      });
      expect(narrowed.results.map((track) => track.id)).toEqual([mcp.songs.letItBe!.id]);

      // "The Art of Noise" is tagged "Art Of Noise, The".
      const reordered = yield* mcp.call<{ results: { id: string }[] }>('search_tracks', {
        query: 'legs',
        artist: 'The Art of Noise',
      });
      expect(reordered.results.map((track) => track.id)).toEqual([mcp.songs.legs!.id]);
    }),
  );

  it.effect('list artists with plays, and an artist’s songs by album', () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      const byPlays = yield* mcp.call<{
        totalArtists: number;
        tracksWithoutArtist: number;
        artists: { name: string; trackCount: number; albumCount: number; playCount: number }[];
      }>('list_artists', { profileId, sort: 'plays' });
      expect(byPlays).toMatchObject({ totalArtists: 3, tracksWithoutArtist: 1 });
      expect(byPlays.artists).toEqual([
        expect.objectContaining({ name: 'Björk', trackCount: 2, albumCount: 1, playCount: 4 }),
        expect.objectContaining({ name: 'The Beatles', trackCount: 2, albumCount: 2, playCount: 2 }),
        expect.objectContaining({ name: 'Art Of Noise, The', trackCount: 1, albumCount: 0, playCount: 0 }),
      ]);

      const filtered = yield* mcp.call<{ artists: { name: string }[] }>('list_artists', { profileId, query: 'beat' });
      expect(filtered.artists.map((artist) => artist.name)).toEqual(['The Beatles']);
      const withThe = yield* mcp.call<{ artists: { name: string }[] }>('list_artists', {
        profileId,
        query: 'The Art of Noise',
      });
      expect(withThe.artists.map((artist) => artist.name)).toEqual(['Art Of Noise, The']);

      const artist = yield* mcp.call<{
        artist: string;
        albums: { album: string; tracks: { id: string; playCount: number }[] }[];
      }>('get_artist', { profileId, name: 'björk' });
      expect(artist.artist).toBe('Björk');
      expect(artist.albums).toEqual([
        {
          album: 'Homogenic',
          tracks: [
            expect.objectContaining({ id: mcp.songs.hunter!.id, playCount: 1 }),
            expect.objectContaining({ id: mcp.songs.joga!.id, playCount: 3 }),
          ],
        },
      ]);
      expect((yield* Effect.flip(mcp.call('get_artist', { profileId, name: 'Queen' }))).message).toMatch(
        /No songs are tagged/,
      );
    }),
  );

  it.effect('summarize listening, all time or over recent days', () =>
    Effect.gen(function* () {
      const mcp = yield* Mcp;
      type Stats = {
        totalPlays: number;
        distinctTracks: number;
        topTracks: { id: string; playCount: number }[];
        topArtists: { name: string; playCount: number; trackCount: number }[];
        recentPlays: { id: string }[];
      };
      const allTime = yield* mcp.call<Stats>('get_listening_stats', { profileId });
      expect(allTime).toMatchObject({ totalPlays: 6, distinctTracks: 3 });
      expect(allTime.topTracks.map((track) => [track.id, track.playCount])).toEqual([
        [mcp.songs.joga!.id, 3],
        [mcp.songs.letItBe!.id, 2],
        [mcp.songs.hunter!.id, 1],
      ]);
      expect(allTime.topArtists).toEqual([
        { name: 'Björk', playCount: 4, trackCount: 2 },
        { name: 'The Beatles', playCount: 2, trackCount: 1 },
      ]);
      expect(allTime.recentPlays.at(-1)!.id).toBe(mcp.songs.letItBe!.id);

      const lastMonth = yield* mcp.call<Stats>('get_listening_stats', { profileId, days: 30 });
      expect(lastMonth).toMatchObject({ totalPlays: 4, distinctTracks: 2 });

      const someoneElse = yield* mcp.call<Stats>('get_listening_stats', { profileId: otherProfileId });
      expect(someoneElse).toMatchObject({ totalPlays: 0, topTracks: [], recentPlays: [] });
    }),
  );
});
