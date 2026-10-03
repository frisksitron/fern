import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { expect, layer } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
import { SqlClient, type SqlError } from 'effect/sql';
import { schema as zeroSchema } from '../../src/lib/zero/schema';
import { TestDatabase } from './support/database';

type ZeroTable = { name: string; serverName?: string; columns: Record<string, { serverName?: string }> };

/** The SQLSTATE and constraint behind a statement PostgreSQL rejected. */
const rejection = <A, R>(statement: Effect.Effect<A, SqlError.SqlError, R>) =>
  Effect.flip(statement).pipe(
    Effect.map((error) => {
      // The PostgreSQL error's fields, as @effect/sql-pg attaches them to the cause.
      const cause = error.reason.cause as { readonly code?: string; readonly constraint?: string };
      return { code: cause.code, constraint: cause.constraint };
    }),
  );

layer(Layer.merge(TestDatabase.layer, NodeServices.layer), { excludeTestServices: true })(
  'migrations from an empty database',
  (it) => {
    it.effect('apply every migration folder', () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sql = yield* SqlClient.SqlClient;
        const names = yield* fs.readDirectory('migrations');
        const kinds = yield* Effect.forEach(names, (name) => fs.stat(path.join('migrations', name)));
        const folders = names.filter((_, index) => kinds[index]!.type === 'Directory').sort();
        const applied = yield* sql<{ name: string }>`select name from drizzle.__drizzle_migrations order by id`;
        expect(applied.map((row) => row.name)).toEqual(folders);

        const tables = yield* sql<{ table_name: string }>`select table_name from information_schema.tables
          where table_schema = 'public' order by table_name`;
        expect(tables.map((row) => row.table_name)).toEqual([
          'external_subtitles',
          'media_chapters',
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
          'youtube_downloads',
        ]);
      }),
    );

    it.effect('publish exactly the columns the generated Zero schema synchronizes', () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const published = yield* sql<{ tablename: string; attnames: string[] }>`
          select tablename, attnames::text[] as attnames from pg_publication_tables where pubname = 'fern_data'`;
        const actual = Object.fromEntries(published.map((row) => [row.tablename, [...row.attnames].sort()]));
        const expected = Object.fromEntries(
          (Object.values(zeroSchema.tables) as ZeroTable[]).map((table) => [
            table.serverName ?? table.name,
            Object.entries(table.columns)
              .map(([name, column]) => column.serverName ?? name)
              .sort(),
          ]),
        );
        expect(actual).toEqual(expected);
      }),
    );
  },
);

layer(TestDatabase.layer, { excludeTestServices: true })('existing database constraints', (it) => {
  it.effect('reject unknown media root types', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insert = sql`insert into media_roots (id, path, display_name, media_type)
        values (${randomUUID()}, ${`/constraints/${randomUUID()}`}, 'Photos', 'photo')`;
      expect(yield* rejection(insert)).toEqual({ code: '23514', constraint: 'media_root_type' });
    }),
  );

  it.effect('reject duplicate media root paths', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const path = `/constraints/${randomUUID()}`;
      yield* sql`insert into media_roots (id, path, display_name, media_type)
        values (${randomUUID()}, ${path}, 'First', 'video')`;
      const second = sql`insert into media_roots (id, path, display_name, media_type)
        values (${randomUUID()}, ${path}, 'Second', 'video')`;
      expect(yield* rejection(second)).toEqual({ code: '23505', constraint: 'media_root_path' });
    }),
  );

  it.effect('reject blank profile names', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insert = sql`insert into profiles (id, name, avatar_key) values (${randomUUID()}, '   ', 'avatar-01')`;
      expect(yield* rejection(insert)).toEqual({ code: '23514', constraint: 'profile_name_length' });
    }),
  );
});
