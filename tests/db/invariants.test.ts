import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ScanState } from '../../src/lib/shared/contracts/scans';
import { createTestDatabase, type TestDatabase } from './support/database';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await database.pool.query('truncate scan_runs, media_roots, profiles cascade');
});

const query = (text: string, params: unknown[] = []) => database.pool.query(text, params);

async function insertRoot() {
  const id = randomUUID();
  await query(`insert into media_roots (id, path, display_name, media_type) values ($1, $2, 'Root', 'video')`, [
    id,
    `/roots/${id}`,
  ]);
  return id;
}

async function insertEntry(rootId: string, columns: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    id: randomUUID(),
    media_root_id: rootId,
    relative_path: `file-${randomUUID()}.mp4`,
    name: 'file.mp4',
    kind: 'file',
    mtime_ms: 0,
    ...columns,
  };
  const keys = Object.keys(values);
  await query(
    `insert into media_entries (${keys.join(', ')}) values (${keys.map((_, index) => `$${index + 1}`).join(', ')})`,
    Object.values(values),
  );
  return values.id as string;
}

async function insertScan(state: string, requestedAt = new Date()) {
  const id = randomUUID();
  await query(`insert into scan_runs (id, state, requested_at) values ($1, $2, $3)`, [id, state, requestedAt]);
  return id;
}

describe('database invariants', () => {
  it('give every foreign key a supporting index', async () => {
    // An index supports a foreign key when the key's columns are the index's leading columns.
    const { rows } = await query(`
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
      order by 1, 2`);
    expect(rows).toEqual([]);
  });

  it('accept exactly the scan states the API publishes', async () => {
    for (const state of ScanState.literals) {
      const id = await insertScan(state);
      await query('delete from scan_runs where id = $1', [id]);
    }
    await expect(insertScan('paused')).rejects.toMatchObject({ code: '23514', constraint: 'scan_state' });
  });

  it('allow only one queued, running, or retrying scan at a time', async () => {
    await insertScan('completed');
    await insertScan('failed');
    await insertScan('retrying');
    for (const state of ['queued', 'running', 'retrying'])
      await expect(insertScan(state)).rejects.toMatchObject({ code: '23505', constraint: 'scan_single_active' });
    await insertScan('completed');
  });

  it('hold a scan job lease exactly while the job runs, and a finish time exactly once it ends', async () => {
    const insertJob = async (columns: string, values: string) =>
      query(`insert into scan_jobs (scan_run_id, max_attempts, ${columns}) values ($1, 3, ${values})`, [
        await insertScan('completed'),
      ]);
    await expect(insertJob('state', `'running'`)).rejects.toMatchObject({ constraint: 'scan_job_lease' });
    await expect(insertJob('state, locked_by', `'pending', 'worker'`)).rejects.toMatchObject({
      constraint: 'scan_job_lease',
    });
    await expect(insertJob('state', `'completed'`)).rejects.toMatchObject({ constraint: 'scan_job_finished_at' });
    await expect(insertJob('state, attempts', `'pending', -1`)).rejects.toMatchObject({
      constraint: 'scan_job_attempts',
    });
    await expect(insertJob('state, locked_by, locked_until', `'running', 'worker', now()`)).resolves.toBeDefined();
    await expect(insertJob('state, finished_at', `'failed', now()`)).resolves.toBeDefined();
  });

  it('keep scan history when a media root is removed', async () => {
    const rootId = await insertRoot();
    const scanId = await insertScan('completed');
    await query(
      `insert into scan_errors (id, scan_run_id, media_root_id, stage, error_code, message)
       values ($1, $2, $3, 'probe', 'FFPROBE_FAILED', 'broken')`,
      [randomUUID(), scanId, rootId],
    );
    await query('delete from media_roots where id = $1', [rootId]);
    const { rows } = await query('select media_root_id from scan_errors where scan_run_id = $1', [scanId]);
    expect(rows).toEqual([{ media_root_id: null }]);
  });

  it('reject invalid states, kinds, and negative numbers even when the application is bypassed', async () => {
    const rootId = await insertRoot();
    const entryId = await insertEntry(rootId, { is_video: true, duration_ms: 1_000 });
    const profileId = randomUUID();
    await query(`insert into profiles (id, name, avatar_key) values ($1, 'Ada', 'avatar-01')`, [profileId]);

    const rejected: Array<[() => Promise<unknown>, string]> = [
      [() => insertEntry(rootId, { probe_status: 'ready' }), 'entry_probe_status'],
      [() => insertEntry(rootId, { is_video: true, is_audio: true }), 'entry_media_flags'],
      [() => insertEntry(rootId, { kind: 'directory', is_video: true }), 'entry_media_flags'],
      [() => insertEntry(rootId, { size_bytes: -1 }), 'entry_non_negative'],
      [() => insertEntry(rootId, { duration_ms: -5 }), 'entry_non_negative'],
      [
        () =>
          query(
            `insert into media_tracks (id, media_entry_id, stream_index, kind, codec) values ($1, $2, 0, 'data', 'bin')`,
            [randomUUID(), entryId],
          ),
        'track_kind',
      ],
      [
        () =>
          query(
            `insert into external_subtitles (id, media_entry_id, relative_path, name, format, mtime_ms)
           values ($1, $2, 'a.ass', 'a.ass', 'ass', 0)`,
            [randomUUID(), entryId],
          ),
        'subtitle_format',
      ],
      [
        () =>
          query(`insert into playback_progress (profile_id, media_entry_id, position_ms) values ($1, $2, -1)`, [
            profileId,
            entryId,
          ]),
        'progress_non_negative',
      ],
      [() => query(`update media_roots set display_order = -1 where id = $1`, [rootId]), 'media_root_display_order'],
    ];
    for (const [attempt, constraint] of rejected) {
      await expect(attempt(), constraint).rejects.toMatchObject({ code: '23514', constraint });
    }
  });
});
