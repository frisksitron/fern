import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { zeroNodePg } from '@rocicorp/zero/server/adapters/pg';
import { Cause, Effect, Exit, Option } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, toolFailureMessage, type ToolRunner } from '../../src/lib/server/mcp/server';
import { mutators } from '../../src/lib/zero/mutators';
import { schema as zeroSchema } from '../../src/lib/zero/schema';
import { createTestDatabase, type TestDatabase } from './support/database';

const profileId = randomUUID();
const otherProfileId = randomUUID();
const musicRoot = randomUUID();

type Seeded = { id: string; title: string | null; artist: string | null; album: string | null };

let database: TestDatabase;
let client: Client;
const songs: Record<string, Seeded> = {};

/** Runs tools on the test database, reporting typed failures as the /mcp route does. */
const run: ToolRunner = async (program) => {
  const exit = await database.run(Effect.exit(program));
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  throw new Error(Option.isSome(failure) ? toolFailureMessage(failure.value) : 'Something went wrong.');
};

async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error((result.content as { text: string }[])[0]?.text);
  return result.structuredContent as T;
}

async function addSong(key: string, path: string, tags: Partial<Omit<Seeded, 'id'>> & { trackNumber?: number }) {
  const id = randomUUID();
  const name = path.split('/').at(-1)!;
  await database.pool.query(
    `insert into media_entries (id, media_root_id, relative_path, name, kind, mtime_ms, is_audio, duration_ms,
       title, artist, album, track_number, probe_status)
     values ($1, $2, $3, $4, 'file', 0, true, 200000, $5, $6, $7, $8, 'ok')`,
    [id, musicRoot, path, name, tags.title ?? null, tags.artist ?? null, tags.album ?? null, tags.trackNumber ?? null],
  );
  songs[key] = { id, title: tags.title ?? null, artist: tags.artist ?? null, album: tags.album ?? null };
  return id;
}

async function play(key: string, times: number, daysAgo = 0) {
  for (let index = 0; index < times; index++) {
    await database.pool.query(
      `insert into track_plays (id, profile_id, media_entry_id, played_at) values ($1, $2, $3, now() - ($4 || ' days')::interval)`,
      [randomUUID(), profileId, songs[key]!.id, daysAgo],
    );
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  await database.pool.query(
    `insert into profiles (id, name, avatar_key) values ($1, 'Listener', 'fern'), ($2, 'Someone else', 'fern')`,
    [profileId, otherProfileId],
  );
  await database.pool.query(
    `insert into media_roots (id, path, display_name, media_type) values ($1, '/library/music', 'Music', 'music')`,
    [musicRoot],
  );
  await addSong('heyJude', 'Beatles/1/01 Hey Jude.flac', {
    title: 'Hey Jude - Remastered 2015',
    artist: 'The Beatles',
    album: '1',
    trackNumber: 1,
  });
  await addSong('letItBe', 'Beatles/Let It Be/06 Let It Be.flac', {
    title: 'Let It Be',
    artist: 'The Beatles',
    album: 'Let It Be',
    trackNumber: 6,
  });
  await addSong('joga', 'Björk/Homogenic/03 Jóga.flac', {
    title: 'Jóga',
    artist: 'Björk',
    album: 'Homogenic',
    trackNumber: 3,
  });
  // The same artist spelled without the accent is still one artist.
  await addSong('hunter', 'Björk/Homogenic/01 Hunter.flac', {
    title: 'Hunter',
    artist: 'Bjork',
    album: 'Homogenic',
    trackNumber: 1,
  });
  await addSong('teardrop', 'Massive Attack/Mezzanine/03 - Teardrop.mp3', {});
  await addSong('legs', 'Art of Noise/Legs.flac', { title: 'Legs', artist: 'Art Of Noise, The' });
  const removed = await addSong('removed', 'Gone/Gone.flac', { title: 'Gone', artist: 'Nobody' });
  await database.pool.query(`update media_entries set deleted_at = now() where id = $1`, [removed]);

  await play('joga', 3, 1);
  await play('hunter', 1, 1);
  await play('letItBe', 2, 100);

  const server = createMcpServer(run);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'fern-test', version: '1.0.0' });
  await client.connect(clientTransport);
  // Listing tools lets the client check every result against the tool's output schema.
  await client.listTools();
});

afterAll(async () => {
  await client?.close();
  await database?.drop();
});

type Match = { confidence: string; match: { id: string; title: string } | null };
type AppendResult = {
  playlist: { id: string; name: string; trackCount: number };
  added: string[];
  alreadyInPlaylist: string[];
  notFound: string[];
};

describe('MCP music tools', () => {
  it('offer the music tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
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
  });

  it('turn a tracklist into a playlist', async () => {
    const { matches } = await call<{ matches: Match[] }>('match_tracks', {
      tracks: [
        { title: 'Hey Jude', artist: 'Beatles' },
        { title: 'Joga', artist: 'Bjork' },
        { title: 'Teardrop', artist: 'Massive Attack' },
        { title: 'Gone', artist: 'Nobody' },
        { title: 'Bohemian Rhapsody', artist: 'Queen' },
      ],
    });
    expect(matches.map((match) => [match.confidence, match.match?.id ?? null])).toEqual([
      ['exact', songs.heyJude!.id],
      ['exact', songs.joga!.id],
      ['exact', songs.teardrop!.id],
      ['none', null],
      ['none', null],
    ]);
    // Untagged songs are named after their file.
    expect(matches[2]!.match!.title).toBe('Teardrop');

    const found = matches.flatMap((match) => (match.match ? [match.match.id] : []));
    const missing = randomUUID();
    const created = await call<AppendResult>('create_playlist', {
      profileId,
      name: '  Road trip  ',
      trackIds: [...found, found[0], missing, songs.removed!.id],
    });
    expect(created).toMatchObject({
      playlist: { name: 'Road trip', trackCount: 3 },
      added: found,
      alreadyInPlaylist: [],
      notFound: [missing, songs.removed!.id],
    });

    const { playlist, tracks } = await call<{
      playlist: { trackCount: number; durationMs: number };
      tracks: { id: string; playCount: number }[];
    }>('get_playlist', { profileId, playlistId: created.playlist.id });
    expect(tracks.map((track) => track.id)).toEqual(found);
    expect(tracks.map((track) => track.playCount)).toEqual([0, 3, 0]);
    expect(playlist).toMatchObject({ trackCount: 3, durationMs: 600_000 });

    const { playlists } = await call<{ playlists: { id: string; trackCount: number }[] }>('list_playlists', {
      profileId,
    });
    expect(playlists).toEqual([expect.objectContaining({ id: created.playlist.id, trackCount: 3 })]);
  });

  it('append to a playlist after its last item, skipping songs it holds', async () => {
    const created = await call<AppendResult>('create_playlist', {
      profileId,
      name: 'Mix',
      trackIds: [songs.heyJude!.id, songs.letItBe!.id],
    });
    // Removing the first item leaves a gap in positions.
    await database.pool.query(`delete from playlist_items where playlist_id = $1 and media_entry_id = $2`, [
      created.playlist.id,
      songs.heyJude!.id,
    ]);
    // A song removed from the library stays in the playlist but is not counted.
    await database.pool.query(
      `insert into playlist_items (id, playlist_id, media_entry_id, position) values ($1, $2, $3, 5)`,
      [randomUUID(), created.playlist.id, songs.removed!.id],
    );
    const added = await call<AppendResult>('add_to_playlist', {
      profileId,
      playlistId: created.playlist.id,
      trackIds: [songs.letItBe!.id, songs.hunter!.id, songs.joga!.id],
    });
    expect(added).toMatchObject({
      playlist: { name: 'Mix', trackCount: 3 },
      added: [songs.hunter!.id, songs.joga!.id],
      alreadyInPlaylist: [songs.letItBe!.id],
      notFound: [],
    });
    const positions = await database.pool.query<{ position: number }>(
      `select position from playlist_items where playlist_id = $1 order by position`,
      [created.playlist.id],
    );
    expect(positions.rows.map((row) => row.position)).toEqual([1, 5, 6, 7]);
  });

  it('serialize appends to one playlist from Zero and from MCP', async () => {
    const created = await call<AppendResult>('create_playlist', { profileId, name: 'Busy' });
    const playlistId = created.playlist.id;
    const ids = ['heyJude', 'letItBe', 'joga', 'hunter', 'teardrop'].map((key) => songs[key]!.id);
    // Zero's server transaction, as /api/zero/mutate runs `playlists.addTracks`.
    const zero = zeroNodePg(zeroSchema, database.pool);
    const zeroAppend = (mediaEntryId: string) =>
      zero.transaction((tx) =>
        mutators.playlists.addTracks.fn({
          tx,
          args: { playlistId, tracks: [{ id: randomUUID(), mediaEntryId }], now: Date.now() },
          ctx: undefined,
        } as never),
      );
    // Every song is appended twice at once, once through each path.
    await Promise.all(
      ids.flatMap((id, index) => [
        zeroAppend(id),
        call('add_to_playlist', { profileId, playlistId, trackIds: [ids[(index + 1) % ids.length]] }),
      ]),
    );
    const items = await database.pool.query<{ media_entry_id: string; position: number }>(
      `select media_entry_id, position from playlist_items where playlist_id = $1 order by position`,
      [playlistId],
    );
    expect(items.rows.map((row) => row.position)).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(items.rows.map((row) => row.media_entry_id))).toEqual(new Set(ids));
  });

  it('reorder a playlist, keeping songs removed from the library at the end', async () => {
    const [a, b, c] = ['heyJude', 'letItBe', 'joga'].map((key) => songs[key]!.id);
    const created = await call<AppendResult>('create_playlist', { profileId, name: 'Order', trackIds: [a, b, c] });
    const playlistId = created.playlist.id;
    // A removed song, which get_playlist does not show, sits between the others.
    await database.pool.query(
      `update playlist_items set position = position + 1 where playlist_id = $1 and position > 0`,
      [playlistId],
    );
    await database.pool.query(
      `insert into playlist_items (id, playlist_id, media_entry_id, position) values ($1, $2, $3, 1)`,
      [randomUUID(), playlistId, songs.removed!.id],
    );

    const reordered = await call<{ playlist: { trackCount: number }; trackIds: string[] }>('reorder_playlist', {
      profileId,
      playlistId,
      trackIds: [c, a, b],
    });
    expect(reordered).toMatchObject({ playlist: { trackCount: 3 }, trackIds: [c, a, b] });
    const { tracks } = await call<{ tracks: { id: string }[] }>('get_playlist', { profileId, playlistId });
    expect(tracks.map((track) => track.id)).toEqual([c, a, b]);
    const items = await database.pool.query<{ media_entry_id: string; position: number }>(
      `select media_entry_id, position from playlist_items where playlist_id = $1 order by position`,
      [playlistId],
    );
    expect(items.rows).toEqual([
      { media_entry_id: c, position: 0 },
      { media_entry_id: a, position: 1 },
      { media_entry_id: b, position: 2 },
      { media_entry_id: songs.removed!.id, position: 3 },
    ]);
  });

  it('refuse an order that does not list every track exactly once, changing nothing', async () => {
    const [a, b, c] = ['heyJude', 'letItBe', 'joga'].map((key) => songs[key]!.id);
    const created = await call<AppendResult>('create_playlist', { profileId, name: 'Strict', trackIds: [a, b, c] });
    const playlistId = created.playlist.id;
    const reorder = (trackIds: string[]) => call('reorder_playlist', { profileId, playlistId, trackIds });
    const other = songs.hunter!.id;

    await expect(reorder([c, a])).rejects.toThrow(`missing: ${b}`);
    await expect(reorder([c, a, b, other])).rejects.toThrow(`not in the playlist: ${other}`);
    await expect(reorder([c, a, b, a])).rejects.toThrow(`listed more than once: ${a}`);
    await expect(
      call('reorder_playlist', { profileId: otherProfileId, playlistId, trackIds: [c, a, b] }),
    ).rejects.toThrow('Playlist not found for this profile');
    const { tracks } = await call<{ tracks: { id: string }[] }>('get_playlist', { profileId, playlistId });
    expect(tracks.map((track) => track.id)).toEqual([a, b, c]);
  });

  it('refuse playlists of other profiles and unknown profiles', async () => {
    const created = await call<AppendResult>('create_playlist', { profileId, name: 'Mine' });
    await expect(
      call('add_to_playlist', {
        profileId: otherProfileId,
        playlistId: created.playlist.id,
        trackIds: [songs.joga!.id],
      }),
    ).rejects.toThrow('Playlist not found for this profile');
    await expect(call('create_playlist', { profileId: randomUUID(), name: 'Nobody’s' })).rejects.toThrow(
      'Profile not found',
    );
    await expect(call('create_playlist', { profileId, name: '   ' })).rejects.toThrow();
  });

  it('search songs by words, ignoring accents', async () => {
    const { total, results } = await call<{ total: number; results: { id: string }[] }>('search_tracks', {
      query: 'bjork',
    });
    expect(total).toBe(2);
    expect(results.map((track) => track.id)).toEqual([songs.hunter!.id, songs.joga!.id]);

    const accented = await call<{ total: number }>('search_tracks', { query: 'jóga björk' });
    expect(accented.total).toBe(1);

    const narrowed = await call<{ results: { id: string }[] }>('search_tracks', { query: 'let', artist: 'beatles' });
    expect(narrowed.results.map((track) => track.id)).toEqual([songs.letItBe!.id]);

    // "The Art of Noise" is tagged "Art Of Noise, The".
    const reordered = await call<{ results: { id: string }[] }>('search_tracks', {
      query: 'legs',
      artist: 'The Art of Noise',
    });
    expect(reordered.results.map((track) => track.id)).toEqual([songs.legs!.id]);
  });

  it('list artists with plays, and an artist’s songs by album', async () => {
    const byPlays = await call<{
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

    const filtered = await call<{ artists: { name: string }[] }>('list_artists', { profileId, query: 'beat' });
    expect(filtered.artists.map((artist) => artist.name)).toEqual(['The Beatles']);
    const withThe = await call<{ artists: { name: string }[] }>('list_artists', {
      profileId,
      query: 'The Art of Noise',
    });
    expect(withThe.artists.map((artist) => artist.name)).toEqual(['Art Of Noise, The']);

    const artist = await call<{
      artist: string;
      albums: { album: string; tracks: { id: string; playCount: number }[] }[];
    }>('get_artist', { profileId, name: 'björk' });
    expect(artist.artist).toBe('Björk');
    expect(artist.albums).toEqual([
      {
        album: 'Homogenic',
        tracks: [
          expect.objectContaining({ id: songs.hunter!.id, playCount: 1 }),
          expect.objectContaining({ id: songs.joga!.id, playCount: 3 }),
        ],
      },
    ]);
    await expect(call('get_artist', { profileId, name: 'Queen' })).rejects.toThrow(/No songs are tagged/);
  });

  it('summarize listening, all time or over recent days', async () => {
    type Stats = {
      totalPlays: number;
      distinctTracks: number;
      topTracks: { id: string; playCount: number }[];
      topArtists: { name: string; playCount: number; trackCount: number }[];
      recentPlays: { id: string }[];
    };
    const allTime = await call<Stats>('get_listening_stats', { profileId });
    expect(allTime).toMatchObject({ totalPlays: 6, distinctTracks: 3 });
    expect(allTime.topTracks.map((track) => [track.id, track.playCount])).toEqual([
      [songs.joga!.id, 3],
      [songs.letItBe!.id, 2],
      [songs.hunter!.id, 1],
    ]);
    expect(allTime.topArtists).toEqual([
      { name: 'Björk', playCount: 4, trackCount: 2 },
      { name: 'The Beatles', playCount: 2, trackCount: 1 },
    ]);
    expect(allTime.recentPlays.at(-1)!.id).toBe(songs.letItBe!.id);

    const lastMonth = await call<Stats>('get_listening_stats', { profileId, days: 30 });
    expect(lastMonth).toMatchObject({ totalPlays: 4, distinctTracks: 2 });

    const someoneElse = await call<Stats>('get_listening_stats', { profileId: otherProfileId });
    expect(someoneElse).toMatchObject({ totalPlays: 0, topTracks: [], recentPlays: [] });
  });
});
