import { describe, expect, it, vi } from 'vitest';
import { mutators } from '../../src/lib/zero/mutators';

const profileId = '10000000-0000-4000-8000-000000000001';
const mediaEntryId = '30000000-0000-4000-8000-000000000001';

type Location = 'client' | 'server';

/**
 * A stand-in Zero transaction that records writes (and, on the server, SQL) and answers reads in
 * order. `location` is where the mutator runs: the browser's optimistic run, or the server's.
 */
function fakeTransaction(reads: unknown[], location: Location) {
  const writes: Array<[string, string, unknown]> = [];
  const table = (name: string) =>
    new Proxy({}, { get: (_, operation: string) => (value: unknown) => void writes.push([name, operation, value]) });
  const tx = {
    location,
    mutate: new Proxy({}, { get: (_, name: string) => table(name) }),
    run: vi.fn(async () => reads.shift()),
    dbTransaction: {
      query: vi.fn(async (query: string, params: unknown[]) => {
        writes.push(['sql', query, params]);
        return [];
      }),
    },
  };
  return { tx, writes };
}

// The same entry point the server's /api/zero/mutate handler uses: validate, then run.
async function run(
  mutator: { fn: (options: never) => Promise<void> },
  args: unknown,
  reads: unknown[] = [],
  location: Location = 'server',
) {
  const { tx, writes } = fakeTransaction(reads, location);
  await mutator.fn({ args, tx, ctx: undefined } as never);
  return writes;
}

describe('Zero mutators', () => {
  it('leave media roots to the server', () => {
    // POST and DELETE /api/media-roots validate paths and refuse removals during a scan.
    expect(mutators).not.toHaveProperty('mediaRoots');
  });

  it('trim and validate profile input before writing', async () => {
    const writes = await run(mutators.profiles.create, {
      id: profileId,
      name: '  Robin  ',
      avatarKey: 'avatar-03',
      now: 1_000,
    });
    expect(writes).toEqual([
      [
        'profiles',
        'insert',
        { id: profileId, name: 'Robin', avatarKey: 'avatar-03', createdAt: 1_000, updatedAt: 1_000 },
      ],
    ]);

    const invalid = [
      { id: profileId, name: '   ', avatarKey: 'avatar-03', now: 1 },
      { id: profileId, name: 'Ada', avatarKey: 'avatar-99', now: 1 },
      { id: 'not-a-uuid', name: 'Ada', avatarKey: 'avatar-03', now: 1 },
      { id: profileId, name: 'Ada', avatarKey: 'avatar-03', now: -1 },
    ];
    for (const args of invalid) await expect(run(mutators.profiles.create, args)).rejects.toThrow(/Validation failed/);
  });

  it('marks progress watched using millisecond positions', async () => {
    const media = { id: mediaEntryId, durationMs: 100_000 };
    const save = (positionMs: number, watched?: boolean) =>
      run(mutators.progress.save, { profileId, mediaEntryId, positionMs, durationMs: 100_000, watched, now: 5 }, [
        undefined,
        media,
      ]);

    expect((await save(89_000))[0][2]).toMatchObject({ positionMs: 89_000, watched: false });
    expect((await save(90_000))[0][2]).toMatchObject({ positionMs: 90_000, watched: true });
    expect((await save(1_000, true))[0][2]).toMatchObject({ watched: true });
  });

  it('save progress in the browser without the media synchronized, and reject missing media on the server', async () => {
    const args = { profileId, mediaEntryId, positionMs: 5_000, durationMs: null, now: 5 };
    expect(await run(mutators.progress.save, args, [undefined, undefined], 'client')).toEqual([
      [
        'playbackProgress',
        'upsert',
        { profileId, mediaEntryId, positionMs: 5_000, durationMs: null, watched: false, lastPlayedAt: 5, updatedAt: 5 },
      ],
    ]);
    await expect(run(mutators.progress.save, args, [undefined, undefined])).rejects.toThrow(/Media does not exist/);
    await expect(
      run(mutators.progress.setWatched, { profileId, mediaEntryId, watched: true, now: 5 }, [undefined, undefined]),
    ).rejects.toThrow(/Media does not exist/);
  });

  it('reorder a playlist only with every one of its tracks, writing the positions that changed', async () => {
    const playlistId = '40000000-0000-4000-8000-000000000001';
    const [first, second, third] = [1, 2, 3].map((n) => `50000000-0000-4000-8000-00000000000${n}`);
    const items = [first, second, third].map((id, position) => ({ id, playlistId, position }));
    const reorder = (itemIds: string[]) => run(mutators.playlists.reorder, { playlistId, itemIds }, [items]);

    expect(await reorder([third, second, first])).toEqual([
      ['sql', 'select 1 from playlists where id = $1 for update', [playlistId]],
      ['playlistItems', 'update', { id: third, position: 0 }],
      ['playlistItems', 'update', { id: first, position: 2 }],
    ]);
    for (const itemIds of [
      [first, second],
      [first, second, second],
      [first, second, third, first],
    ])
      await expect(reorder(itemIds)).rejects.toThrow(/every track in the playlist once/);
    await expect(reorder([])).rejects.toThrow(/Validation failed/);
  });

  it('remove several playlist items at once, each once', async () => {
    const [first, second] = [1, 2].map((n) => `50000000-0000-4000-8000-00000000000${n}`);
    expect(await run(mutators.playlists.removeTracks, { ids: [first, second, first] })).toEqual([
      ['playlistItems', 'delete', { id: first }],
      ['playlistItems', 'delete', { id: second }],
    ]);
    await expect(run(mutators.playlists.removeTracks, { ids: [] })).rejects.toThrow(/Validation failed/);
  });

  it('append new tracks once each, after the highest position', async () => {
    const playlistId = '40000000-0000-4000-8000-000000000001';
    const [a, b, c] = [1, 2, 3].map((n) => `30000000-0000-4000-8000-00000000001${n}`);
    const [itemA, itemB, itemC] = [1, 2, 3].map((n) => `50000000-0000-4000-8000-00000000001${n}`);
    // Removing the first item left a gap: the remaining item sits at position 1.
    const existing = [{ id: '50000000-0000-4000-8000-000000000001', playlistId, mediaEntryId: a, position: 1 }];
    const writes = await run(
      mutators.playlists.addTracks,
      {
        playlistId,
        tracks: [
          { id: itemA, mediaEntryId: a },
          { id: itemB, mediaEntryId: b },
          { id: itemC, mediaEntryId: b },
          { id: itemC, mediaEntryId: c },
        ],
        now: 7,
      },
      [existing],
    );
    expect(writes).toEqual([
      ['sql', 'select 1 from playlists where id = $1 for update', [playlistId]],
      ['playlistItems', 'insert', { id: itemB, mediaEntryId: b, playlistId, position: 2, createdAt: 7 }],
      ['playlistItems', 'insert', { id: itemC, mediaEntryId: c, playlistId, position: 3, createdAt: 7 }],
    ]);
  });

  it('record a play only for a song that still exists, which only the server can tell', async () => {
    const id = '60000000-0000-4000-8000-000000000001';
    const song = { id: mediaEntryId, isAudio: true, deletedAt: null };
    const play = [['trackPlays', 'insert', { id, profileId, mediaEntryId, playedAt: 9 }]];
    expect(await run(mutators.plays.record, { id, profileId, mediaEntryId, now: 9 }, [song])).toEqual(play);
    await expect(run(mutators.plays.record, { id, profileId, mediaEntryId, now: 9 }, [undefined])).rejects.toThrow(
      /Song does not exist/,
    );
    // The browser may not have the song synchronized (its folder is no longer open): it records the
    // play optimistically and leaves the check to the server.
    expect(await run(mutators.plays.record, { id, profileId, mediaEntryId, now: 9 }, [undefined], 'client')).toEqual(
      play,
    );
    await expect(run(mutators.plays.record, { id: 'nope', profileId, mediaEntryId, now: 9 })).rejects.toThrow(
      /Validation failed/,
    );
  });

  it('require at least one track when adding to a playlist', async () => {
    await expect(
      run(mutators.playlists.addTracks, {
        playlistId: '40000000-0000-4000-8000-000000000001',
        tracks: [],
        now: 1,
      }),
    ).rejects.toThrow(/Validation failed/);
  });
});
