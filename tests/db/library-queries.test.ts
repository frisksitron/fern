import { zeroNodePg } from '@rocicorp/zero/server/adapters/pg';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaEntries, playbackProgress } from '../../src/lib/server/db/schema';
import { loadBrowseSnapshot } from '../../src/lib/server/library/browse';
import { loadContinueWatching, siblingsQuery } from '../../src/lib/server/library/continue-watching';
import { folderTrackIds, folderTracksQuery } from '../../src/lib/server/library/folder-tracks';
import { loadMediaFolder } from '../../src/lib/server/library/folders';
import { mediaEntryColumns, toMediaEntry, toProgress } from '../../src/lib/server/library/rows';
import type { QueryStats } from '../../src/lib/server/library/stats';
import { getDirectoryProgress, searchLibrary, subtreeVideosQuery } from '../../src/lib/server/mcp/library';
import { matchTracks } from '../../src/lib/server/mcp/music';
import type { MediaEntryId, MediaRootId, ProfileId } from '../../src/lib/shared/contracts/ids';
import { CONTINUE_WATCHING_LIMIT, hasResumableProgress } from '../../src/lib/shared/playback-state';
import { findUpNext } from '../../src/lib/shared/sorting';
import { queries } from '../../src/lib/zero/queries';
import { schema as zeroSchema } from '../../src/lib/zero/schema';
import { createTestDatabase, type TestDatabase } from './support/database';

// A library large enough that reading all of it shows up in row counts and query plans:
// 10 categories × 20 shows × 25 episodes of video, and 100 artists × 5 albums × 12 tracks of music.
const CATEGORIES = 10;
const SHOWS_PER_CATEGORY = 20;
const EPISODES = 25;
const ARTISTS = 100;
const ALBUMS = 5;
const TRACKS = 12;
const VIDEO_COUNT = CATEGORIES * SHOWS_PER_CATEGORY * EPISODES;

const profileId = '10000000-0000-4000-8000-00000000000a' as ProfileId;
const videoRoot = '20000000-0000-4000-8000-00000000000a' as MediaRootId;
const musicRoot = '20000000-0000-4000-8000-00000000000b' as MediaRootId;

let database: TestDatabase;

async function seedLibrary() {
  const query = (text: string) => database.pool.query(text);
  // Stable, valid version 4 UUIDs derived from names, so tests can find entries by name.
  await query(`create function test_id(key text) returns uuid immutable language sql
    as $$ select overlay(overlay(md5(key) placing '4' from 13) placing '8' from 17)::uuid $$`);
  await query(`insert into profiles (id, name, avatar_key) values ('${profileId}', 'Viewer', 'fern')`);
  await query(`insert into media_roots (id, path, display_name, media_type) values
    ('${videoRoot}', '/library/video', 'Video', 'video'),
    ('${musicRoot}', '/library/music', 'Music', 'music')`);
  await query(`
    insert into media_entries (id, media_root_id, parent_id, relative_path, name, kind, mtime_ms)
    select test_id('category-' || c), '${videoRoot}', null, 'Category ' || c, 'Category ' || c, 'directory', 0
    from generate_series(1, ${CATEGORIES}) c`);
  await query(`
    insert into media_entries (id, media_root_id, parent_id, relative_path, name, kind, mtime_ms)
    select test_id('show-' || c || '-' || s), '${videoRoot}', test_id('category-' || c),
      'Category ' || c || '/Show ' || s, 'Show ' || s, 'directory', 0
    from generate_series(1, ${CATEGORIES}) c, generate_series(1, ${SHOWS_PER_CATEGORY}) s`);
  await query(`
    insert into media_entries (id, media_root_id, parent_id, relative_path, name, kind, mtime_ms, is_video, duration_ms, probe_status)
    select test_id('episode-' || c || '-' || s || '-' || e), '${videoRoot}', test_id('show-' || c || '-' || s),
      'Category ' || c || '/Show ' || s || '/Episode ' || e || '.mkv', 'Episode ' || e || '.mkv', 'file', 0, true, 1500000, 'ok'
    from generate_series(1, ${CATEGORIES}) c, generate_series(1, ${SHOWS_PER_CATEGORY}) s, generate_series(1, ${EPISODES}) e`);
  await query(`
    insert into media_entries (id, media_root_id, parent_id, relative_path, name, kind, mtime_ms)
    select test_id('artist-' || a), '${musicRoot}', null, 'Artist ' || a, 'Artist ' || a, 'directory', 0
    from generate_series(1, ${ARTISTS}) a`);
  await query(`
    insert into media_entries (id, media_root_id, parent_id, relative_path, name, kind, mtime_ms)
    select test_id('album-' || a || '-' || b), '${musicRoot}', test_id('artist-' || a),
      'Artist ' || a || '/Album ' || b, 'Album ' || b, 'directory', 0
    from generate_series(1, ${ARTISTS}) a, generate_series(1, ${ALBUMS}) b`);
  await query(`
    insert into media_entries (id, media_root_id, parent_id, relative_path, name, kind, mtime_ms, is_audio, album, track_number, probe_status)
    select test_id('track-' || a || '-' || b || '-' || t), '${musicRoot}', test_id('album-' || a || '-' || b),
      'Artist ' || a || '/Album ' || b || '/Track ' || t || '.flac', 'Track ' || t || '.flac', 'file', 0, true,
      'Artist ' || a || ' Album ' || b, t, 'ok'
    from generate_series(1, ${ARTISTS}) a, generate_series(1, ${ALBUMS}) b, generate_series(1, ${TRACKS}) t`);
  // Finished episodes 1–3 of 60 shows, most recent first by show number; half-watched episode 5 of 12 others.
  await query(`
    insert into playback_progress (profile_id, media_entry_id, position_ms, duration_ms, watched, last_played_at)
    select '${profileId}', test_id('episode-' || ((s - 1) / ${SHOWS_PER_CATEGORY} + 1) || '-' || ((s - 1) % ${SHOWS_PER_CATEGORY} + 1) || '-' || e),
      1500000, 1500000, true, now() - (s || ' hours')::interval - (${EPISODES} - e || ' minutes')::interval
    from generate_series(1, 60) s, generate_series(1, 3) e`);
  await query(`
    insert into playback_progress (profile_id, media_entry_id, position_ms, duration_ms, watched, last_played_at)
    select '${profileId}', test_id('episode-' || ((s - 1) / ${SHOWS_PER_CATEGORY} + 1) || '-' || ((s - 1) % ${SHOWS_PER_CATEGORY} + 1) || '-5'),
      600000, 1500000, false, now() - (s || ' minutes')::interval
    from generate_series(101, 112) s`);
  await query('analyze');
}

beforeAll(async () => {
  database = await createTestDatabase();
  await seedLibrary();
}, 60_000);

afterAll(async () => {
  await database?.drop();
});

const id = async (key: string) =>
  (await database.pool.query<{ id: string }>(`select test_id($1)::text as id`, [key])).rows[0].id as MediaEntryId;

async function timed<A>(run: () => Promise<A>) {
  const started = performance.now();
  const value = await run();
  return { value, ms: performance.now() - started };
}

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };

/** The indexes and sequential scans in the plan PostgreSQL chooses for `query`. */
async function planOf(query: SQL | { readonly sql: string; readonly params: unknown[] }) {
  const rows =
    'params' in query
      ? (await database.pool.query(`explain (format json) ${query.sql}`, query.params)).rows
      : await database.query((db) => db.execute(sql`explain (format json) ${query}`, 'objects'));
  const nodes: PlanNode[] = [];
  const visit = (node: PlanNode) => {
    nodes.push(node);
    node.Plans?.forEach(visit);
  };
  visit((rows[0] as { 'QUERY PLAN': { Plan: PlanNode }[] })['QUERY PLAN'][0].Plan);
  return {
    indexes: nodes.map((node) => node['Index Name']).filter(Boolean),
    seqScans: nodes.filter((node) => node['Node Type'] === 'Seq Scan').map((node) => node['Relation Name']),
  };
}

describe('library queries on a large library', () => {
  it('builds continue watching from recent history, reading a small part of the library', async () => {
    const stats: QueryStats = { queries: 0, rows: 0 };
    const { value: row, ms } = await timed(() => database.run(loadContinueWatching(profileId, stats)));
    console.info(`continue watching: ${stats.rows} rows in ${stats.queries} queries, ${ms.toFixed(1)} ms`);

    expect(row.progress).toHaveLength(12);
    expect(row.entries.map((entry) => entry.name)).toEqual(Array(12).fill('Episode 5.mkv'));
    expect(row.upNext).toHaveLength(CONTINUE_WATCHING_LIMIT - 12);
    expect(new Set(row.upNext.map((entry) => entry.name))).toEqual(new Set(['Episode 4.mkv']));
    expect(stats.rows).toBeLessThan(VIDEO_COUNT / 5);
    expect(ms).toBeLessThan(1_000);

    // The same answer as a reference that reads every video and all progress.
    const videos = (
      await database.query((db) =>
        db
          .select(mediaEntryColumns)
          .from(mediaEntries)
          .where(and(isNull(mediaEntries.deletedAt), eq(mediaEntries.isVideo, true))),
      )
    ).map(toMediaEntry);
    const progress = (
      await database.query((db) => db.select().from(playbackProgress).where(eq(playbackProgress.profileId, profileId)))
    ).map(toProgress);
    const continuing = progress
      .filter((item) => hasResumableProgress(item))
      .sort((left, right) => (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0))
      .slice(0, CONTINUE_WATCHING_LIMIT);
    const expected = findUpNext(
      videos,
      progress,
      new Set(continuing.map((item) => item.mediaEntryId)),
      CONTINUE_WATCHING_LIMIT - continuing.length,
    );
    expect(row.progress.map((item) => item.mediaEntryId)).toEqual(continuing.map((item) => item.mediaEntryId));
    expect(row.upNext.map((entry) => entry.id)).toEqual(expected.map((entry) => entry.id));
  });

  it('opens a folder by reading its ancestors, its children, and their progress only', async () => {
    const stats: QueryStats = { queries: 0, rows: 0 };
    const show = await id('show-1-1');
    const { value: snapshot, ms } = await timed(() =>
      database.run(loadBrowseSnapshot(profileId, videoRoot, show, stats)),
    );
    console.info(`open folder: ${stats.rows} rows in ${stats.queries} queries, ${ms.toFixed(1)} ms`);
    expect(snapshot.trail.map((entry) => entry.name)).toEqual(['Category 1', 'Show 1']);
    expect(snapshot.entries).toHaveLength(EPISODES);
    expect(snapshot.folderProgress).toHaveLength(3);
    // The video root, 2 ancestors, 25 episodes, and 3 progress rows.
    expect(stats.rows).toBe(31);
    expect(ms).toBeLessThan(1_000);
  });

  it('lists a music folder’s tracks through its subfolders, and refuses folders over the limit', async () => {
    const { value: ids, ms } = await timed(() =>
      database.query((db) => folderTrackIds(db, musicRoot, null).pipe(Effect.flip)),
    );
    expect(ids).toMatchObject({ _tag: 'FolderTooLarge', limit: 1_000 });

    const artistId = await id('artist-7');
    const artist = await database.query((db) => folderTrackIds(db, musicRoot, artistId));
    console.info(`folder tracks: ${artist.length} tracks, root check ${ms.toFixed(1)} ms`);
    expect(artist).toHaveLength(ALBUMS * TRACKS);
    expect(artist.slice(0, 2)).toEqual([await id('track-7-1-1'), await id('track-7-1-2')]);
  });

  it('summarizes a directory subtree for MCP without scanning the rest of the root', async () => {
    const category = await id('category-1');
    const { value: summary, ms } = await timed(() => database.run(getDirectoryProgress(profileId, category, true)));
    console.info(`MCP directory progress: ${summary.totalVideos} videos, ${ms.toFixed(1)} ms`);
    expect(summary).toMatchObject({
      totalVideos: SHOWS_PER_CATEGORY * EPISODES,
      watchedVideos: SHOWS_PER_CATEGORY * 3,
      inProgressVideos: 0,
    });
    const search = await timed(() => database.run(searchLibrary('show 12 episode 3', 'file', 20)));
    console.info(`MCP search: ${search.value.results.length} results, ${search.ms.toFixed(1)} ms`);
    expect(search.value.results.map((result) => result.breadcrumb.join('/'))).toContain(
      'Video/Category 1/Show 12/Episode 3.mkv',
    );
  });

  it('matches a long tracklist against every song in the library quickly', async () => {
    // Every song is untagged and named "Track N", so titles alone cannot tell them apart.
    const requests = Array.from({ length: 200 }, (_, index) => ({
      title: `Track ${(index % TRACKS) + 1}`,
      artist: `Artist ${(index % ARTISTS) + 1}`,
      album: `Artist ${(index % ARTISTS) + 1} Album ${(index % ALBUMS) + 1}`,
    }));
    const { value, ms } = await timed(() => database.run(matchTracks(requests)));
    console.info(
      `MCP match_tracks: ${requests.length} songs against ${ARTISTS * ALBUMS * TRACKS}, ${ms.toFixed(1)} ms`,
    );
    const expected = await Promise.all(
      requests.map((_, index) => id(`track-${(index % ARTISTS) + 1}-${(index % ALBUMS) + 1}-${(index % TRACKS) + 1}`)),
    );
    expect(value.matches.map((match) => match.match?.id)).toEqual(expected);
    expect(ms).toBeLessThan(5_000);
  });

  it('reads folders, siblings, and subtrees through indexes, never by scanning every entry', async () => {
    const show = await id('show-1-1');
    const shows = await Promise.all([1, 2, 3].map((number) => id(`show-1-${number}`)));
    const siblings = await planOf(
      await database.query((db) =>
        Effect.succeed(
          siblingsQuery(
            db,
            shows.map((parentId) => ({ rootId: videoRoot, parentId })),
          ).toSQL(),
        ),
      ),
    );
    expect(siblings.indexes).toContain('entry_children');
    expect(siblings.seqScans).toEqual([]);

    for (const subtree of [
      folderTracksQuery(musicRoot, await id('artist-7'), 1_001),
      subtreeVideosQuery(await id('category-1')),
    ]) {
      const plan = await planOf(subtree);
      expect(plan.indexes.length).toBeGreaterThan(0);
      expect(plan.seqScans).toEqual([]);
    }

    const byIds = await planOf(
      await database.query((db) =>
        Effect.succeed(
          db
            .select({ id: mediaEntries.id })
            .from(mediaEntries)
            .where(inArray(mediaEntries.id, [show, ...shows]))
            .toSQL(),
        ),
      ),
    );
    expect(byIds.indexes).toContain('media_entries_pkey');
  });

  // Folder pages render the server's snapshot first and then follow Zero's live query for the same
  // folder, so both must select the same entries.
  it('selects the same folder contents as the Zero queries pages follow', async () => {
    const zql = zeroNodePg(zeroSchema, database.pool);
    const cases = [
      { mediaType: 'video', rootId: videoRoot, folderId: null, zero: queries.mediaEntries.children },
      { mediaType: 'video', rootId: videoRoot, folderId: await id('show-2-3'), zero: queries.mediaEntries.children },
      { mediaType: 'music', rootId: musicRoot, folderId: null, zero: queries.mediaEntries.musicChildren },
      {
        mediaType: 'music',
        rootId: musicRoot,
        folderId: await id('album-7-2'),
        zero: queries.mediaEntries.musicChildren,
      },
    ] as const;
    for (const { mediaType, rootId, folderId, zero } of cases) {
      const server = await database.run(loadMediaFolder(mediaType, rootId, folderId));
      const live = await zql.run(zero.fn({ args: { rootId, parentId: folderId }, ctx: undefined }));
      expect(server.entries.length).toBeGreaterThan(0);
      expect(live.map((entry) => entry.id).sort()).toEqual(server.entries.map((entry) => entry.id).sort());
    }
  });
});
