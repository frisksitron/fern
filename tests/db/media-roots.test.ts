import { randomUUID } from 'node:crypto';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer, Redacted } from 'effect';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/lib/server/db/service';
import { MediaRootRepository, type NewMediaRoot } from '../../src/lib/server/media-roots/repository';
import { MediaRootId } from '../../src/lib/shared/contracts/ids';
import { createTestDatabase, type TestDatabase } from './support/database';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

beforeEach(async () => {
  await database.pool.query('truncate media_roots cascade');
});

function root(path: string): NewMediaRoot {
  return { id: MediaRootId.make(randomUUID()), path, displayName: path.split('/').at(-1) ?? path, mediaType: 'video' };
}

type DatabaseLayer = Layer.Layer<Database>;

function repository<A, E>(
  use: (repository: MediaRootRepository['Service']) => Effect.Effect<A, E>,
  databaseLayer: DatabaseLayer = database.layer,
) {
  const layer = MediaRootRepository.layer.pipe(Layer.provide(databaseLayer));
  return Effect.runPromise(Effect.result(Effect.provide(MediaRootRepository.use(use), layer)));
}

function insert(newRoot: NewMediaRoot, databaseLayer?: DatabaseLayer) {
  return repository((roots) => roots.insertIfNoOverlap(newRoot), databaseLayer);
}

describe('MediaRootRepository on PostgreSQL', () => {
  it('appends roots after the highest display order', async () => {
    await database.pool.query(
      `insert into media_roots (id, path, display_name, media_type, display_order) values ($1, '/existing', 'Existing', 'video', 7)`,
      [randomUUID()],
    );
    const result = await insert(root('/library'));
    expect(result).toMatchObject({ _tag: 'Success', success: { path: '/library', displayOrder: 8 } });
    const rows = await database.pool.query('select path, display_order from media_roots order by display_order');
    expect(rows.rows).toEqual([
      { path: '/existing', display_order: 7 },
      { path: '/library', display_order: 8 },
    ]);
  });

  it('rejects roots that overlap existing ones, including case variants of Windows paths', async () => {
    const existing = await insert(root('C:\\Media\\Anime'));
    expect(existing._tag).toBe('Success');
    for (const path of ['C:\\Media', 'c:\\media\\anime', 'C:\\MEDIA\\Anime\\Frieren']) {
      const result = await insert(root(path));
      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'MediaRootOverlap' } });
    }
  });

  it('lets exactly one of many concurrent overlapping creations commit', async () => {
    // Every pair in this chain overlaps (each path contains the next), so only one may win.
    const chain = Array.from({ length: 8 }, (_, depth) => `/library${'/nested'.repeat(depth)}`);
    const results = await Promise.all(chain.map((path) => insert(root(path))));
    expect(results.filter((result) => result._tag === 'Success')).toHaveLength(1);
    expect(results.filter((result) => result._tag === 'Failure')).toHaveLength(chain.length - 1);
    for (const result of results) if (result._tag === 'Failure') expect(result.failure._tag).toBe('MediaRootOverlap');
    expect((await database.pool.query('select count(*)::int as count from media_roots')).rows[0].count).toBe(1);
  });

  it('assigns unique display orders to concurrent non-overlapping creations', async () => {
    const paths = Array.from({ length: 6 }, (_, index) => `/library-${index}`);
    const results = await Promise.all(paths.map((path) => insert(root(path))));
    expect(results.every((result) => result._tag === 'Success')).toBe(true);
    const orders = await database.pool.query<{ display_order: number }>(
      'select display_order from media_roots order by display_order',
    );
    expect(orders.rows.map((row) => row.display_order)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('reports an unreachable database as DatabaseUnavailable', async () => {
    const unreachable = Database.layerWithoutDependencies.pipe(
      Layer.provide(
        PgClient.layer({ url: Redacted.make('postgres://fern:fern@127.0.0.1:1/fern'), connectTimeout: '2 seconds' }),
      ),
      Layer.orDie,
    );
    const result = await insert(root('/unreachable'), unreachable);
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'DatabaseUnavailable' } });
  });

  it('removes a root with everything indexed under it', async () => {
    const created = root('/removable');
    await insert(created);
    await database.pool.query(
      `insert into media_entries (id, media_root_id, relative_path, name, kind, mtime_ms) values ($1, $2, 'a', 'a', 'directory', 0)`,
      [randomUUID(), created.id],
    );
    expect(await repository((roots) => roots.remove(created.id))).toMatchObject({ _tag: 'Success' });
    expect((await database.pool.query('select id from media_entries')).rows).toEqual([]);
    expect(await repository((roots) => roots.remove(created.id))).toMatchObject({
      _tag: 'Failure',
      failure: { _tag: 'MediaRootNotFound' },
    });
  });

  it('refuses to remove a root while a scan is active', async () => {
    const created = root('/scanning');
    await insert(created);
    await database.pool.query(`insert into scan_runs (id, state) values ($1, 'running')`, [randomUUID()]);
    try {
      expect(await repository((roots) => roots.remove(created.id))).toMatchObject({
        _tag: 'Failure',
        failure: { _tag: 'MediaRootBusy' },
      });
      expect((await database.pool.query('select id from media_roots')).rowCount).toBe(1);
    } finally {
      await database.pool.query('truncate scan_runs cascade');
    }
  });
});
