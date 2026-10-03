import { randomUUID } from 'node:crypto';
import { expect, layer } from '@effect/vitest';
import { Effect } from 'effect';
import { SqlClient, type SqlError } from 'effect/sql';
import { ScanState } from '../../src/lib/shared/contracts/scans';
import { TestDatabase } from './support/database';

const reset = TestDatabase.truncate('scan_runs', 'media_roots', 'profiles');

/** The SQLSTATE and constraint behind a statement PostgreSQL rejected. */
const rejection = <A, R>(statement: Effect.Effect<A, SqlError.SqlError, R>) =>
  Effect.flip(statement).pipe(
    Effect.map((error) => {
      // The PostgreSQL error's fields, as @effect/sql-pg attaches them to the cause.
      const cause = error.reason.cause as { readonly code?: string; readonly constraint?: string };
      return { code: cause.code, constraint: cause.constraint };
    }),
  );

const insertRoot = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;
  const id = randomUUID();
  yield* sql`insert into media_roots (id, path, display_name, media_type)
    values (${id}, ${`/roots/${id}`}, 'Root', 'video')`;
  return id;
});

const insertEntry = Effect.fnUntraced(function* (rootId: string, columns: Record<string, unknown> = {}) {
  const sql = yield* SqlClient.SqlClient;
  const values = {
    id: randomUUID(),
    media_root_id: rootId,
    relative_path: `file-${randomUUID()}.mp4`,
    name: 'file.mp4',
    kind: 'file',
    mtime_ms: 0,
    ...columns,
  };
  yield* sql`insert into media_entries ${sql.insert(values)}`;
  return values.id;
});

const insertScan = Effect.fnUntraced(function* (state: string) {
  const sql = yield* SqlClient.SqlClient;
  const id = randomUUID();
  yield* sql`insert into scan_runs (id, state, requested_at) values (${id}, ${state}, now())`;
  return id;
});

layer(TestDatabase.layer, { excludeTestServices: true })('database invariants', (it) => {
  it.effect('give every foreign key a supporting index', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // An index supports a foreign key when the key's columns are the index's leading columns.
      const unsupported = yield* sql`
        select c.conrelid::regclass::text as table_name, c.conname as constraint_name
        from pg_constraint c
        where c.contype = 'f'
          and c.connamespace = 'public'::regnamespace
          and not exists (
            select 1 from pg_index i
            where i.indrelid = c.conrelid
              and array_length(c.conkey, 1) <= i.indnkeyatts
              and (
                select array_agg(key) from unnest(i.indkey::int2[]) with ordinality as index_keys(key, ordinal)
                where ordinal <= array_length(c.conkey, 1)
              ) @> c.conkey
          )
        order by 1, 2`;
      expect(unsupported).toEqual([]);
    }),
  );

  it.effect('accept exactly the scan states the API publishes', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      for (const state of ScanState.literals) {
        const id = yield* insertScan(state);
        yield* sql`delete from scan_runs where id = ${id}`;
      }
      expect(yield* rejection(insertScan('paused'))).toEqual({ code: '23514', constraint: 'scan_state' });
    }),
  );

  it.effect('allow only one queued, running, or retrying scan at a time', () =>
    Effect.gen(function* () {
      yield* reset;
      yield* insertScan('completed');
      yield* insertScan('failed');
      yield* insertScan('retrying');
      for (const state of ['queued', 'running', 'retrying'])
        expect(yield* rejection(insertScan(state))).toEqual({ code: '23505', constraint: 'scan_single_active' });
      yield* insertScan('completed');
    }),
  );

  it.effect('hold a scan job lease exactly while the job runs, and a finish time exactly once it ends', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const insertJob = (columns: string, values: string) =>
        Effect.flatMap(insertScan('completed'), (scanId) =>
          sql.unsafe(`insert into scan_jobs (scan_run_id, max_attempts, ${columns}) values ($1, 3, ${values})`, [
            scanId,
          ]),
        );
      expect(yield* rejection(insertJob('state', `'running'`))).toMatchObject({ constraint: 'scan_job_lease' });
      expect(yield* rejection(insertJob('state, locked_by', `'pending', 'worker'`))).toMatchObject({
        constraint: 'scan_job_lease',
      });
      expect(yield* rejection(insertJob('state', `'completed'`))).toMatchObject({ constraint: 'scan_job_finished_at' });
      expect(yield* rejection(insertJob('state, attempts', `'pending', -1`))).toMatchObject({
        constraint: 'scan_job_attempts',
      });
      yield* insertJob('state, locked_by, locked_until', `'running', 'worker', now()`);
      yield* insertJob('state, finished_at', `'failed', now()`);
    }),
  );

  it.effect('keep scan history when a media root is removed', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const rootId = yield* insertRoot();
      const scanId = yield* insertScan('completed');
      yield* sql`insert into scan_errors (id, scan_run_id, media_root_id, stage, error_code, message)
        values (${randomUUID()}, ${scanId}, ${rootId}, 'probe', 'FFPROBE_FAILED', 'broken')`;
      yield* sql`delete from media_roots where id = ${rootId}`;
      expect(yield* sql`select media_root_id from scan_errors where scan_run_id = ${scanId}`).toEqual([
        { media_root_id: null },
      ]);
    }),
  );

  it.effect('reject invalid states, kinds, and negative numbers even when the application is bypassed', () =>
    Effect.gen(function* () {
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const rootId = yield* insertRoot();
      const entryId = yield* insertEntry(rootId, { is_video: true, duration_ms: 1_000 });
      const profileId = randomUUID();
      yield* sql`insert into profiles (id, name, avatar_key) values (${profileId}, 'Ada', 'avatar-01')`;

      const rejected: Array<[Effect.Effect<unknown, SqlError.SqlError, SqlClient.SqlClient>, string]> = [
        [insertEntry(rootId, { probe_status: 'ready' }), 'entry_probe_status'],
        [insertEntry(rootId, { is_video: true, is_audio: true }), 'entry_media_flags'],
        [insertEntry(rootId, { kind: 'directory', is_video: true }), 'entry_media_flags'],
        [insertEntry(rootId, { size_bytes: -1 }), 'entry_non_negative'],
        [insertEntry(rootId, { duration_ms: -5 }), 'entry_non_negative'],
        [
          sql`insert into media_tracks (id, media_entry_id, stream_index, kind, codec)
            values (${randomUUID()}, ${entryId}, 0, 'data', 'bin')`,
          'track_kind',
        ],
        [
          sql`insert into external_subtitles (id, media_entry_id, relative_path, name, format, mtime_ms)
            values (${randomUUID()}, ${entryId}, 'a.ass', 'a.ass', 'ass', 0)`,
          'subtitle_format',
        ],
        [
          sql`insert into playback_progress (profile_id, media_entry_id, position_ms) values (${profileId}, ${entryId}, -1)`,
          'progress_non_negative',
        ],
        [sql`update media_roots set display_order = -1 where id = ${rootId}`, 'media_root_display_order'],
      ];
      for (const [attempt, constraint] of rejected)
        expect(yield* rejection(attempt), constraint).toEqual({ code: '23514', constraint });
    }),
  );
});
