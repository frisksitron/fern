import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema as zeroSchema } from '../../src/lib/zero/schema';
import { createTestDatabase, type TestDatabase } from './support/database';

type ZeroTable = { name: string; serverName?: string; columns: Record<string, { serverName?: string }> };

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

describe('migrations from an empty database', () => {
  it('apply every migration folder', async () => {
    const folders = (await readdir('migrations', { withFileTypes: true })).filter((entry) => entry.isDirectory());
    const applied = await database.pool.query<{ name: string }>(
      'select name from drizzle.__drizzle_migrations order by id',
    );
    expect(applied.rows.map((row) => row.name)).toEqual(folders.map((folder) => folder.name).sort());

    const tables = await database.pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'external_subtitles',
      'media_entries',
      'media_roots',
      'media_tracks',
      'playback_progress',
      'playlist_items',
      'playlists',
      'profiles',
      'scan_errors',
      'scan_jobs',
      'scan_runs',
      'track_plays',
    ]);
  });

  it('publish exactly the columns the generated Zero schema synchronizes', async () => {
    const published = await database.pool.query<{ tablename: string; attnames: string[] }>(
      `select tablename, attnames::text[] as attnames from pg_publication_tables where pubname = 'fern_data'`,
    );
    const actual = Object.fromEntries(published.rows.map((row) => [row.tablename, [...row.attnames].sort()]));
    const expected = Object.fromEntries(
      (Object.values(zeroSchema.tables) as ZeroTable[]).map((table) => [
        table.serverName ?? table.name,
        Object.entries(table.columns)
          .map(([name, column]) => column.serverName ?? name)
          .sort(),
      ]),
    );
    expect(actual).toEqual(expected);
  });
});

describe('existing database constraints', () => {
  it('reject unknown media root types', async () => {
    await expect(
      database.pool.query(
        `insert into media_roots (id, path, display_name, media_type) values ($1, $2, 'Photos', 'photo')`,
        [randomUUID(), `/constraints/${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'media_root_type' });
  });

  it('reject duplicate media root paths', async () => {
    const path = `/constraints/${randomUUID()}`;
    await database.pool.query(
      `insert into media_roots (id, path, display_name, media_type) values ($1, $2, 'First', 'video')`,
      [randomUUID(), path],
    );
    await expect(
      database.pool.query(
        `insert into media_roots (id, path, display_name, media_type) values ($1, $2, 'Second', 'video')`,
        [randomUUID(), path],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'media_root_path' });
  });

  it('reject blank profile names', async () => {
    await expect(
      database.pool.query(`insert into profiles (id, name, avatar_key) values ($1, '   ', 'avatar-01')`, [
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'profile_name_length' });
  });
});
