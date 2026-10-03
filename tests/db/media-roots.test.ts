import { randomUUID } from 'node:crypto';
import { PgClient } from '@effect/sql-pg';
import { expect, layer } from '@effect/vitest';
import { Effect, Layer, Redacted } from 'effect';
import { SqlClient } from 'effect/sql';
import { Database } from '../../src/lib/server/db/service';
import { MediaRootRepository, type NewMediaRoot } from '../../src/lib/server/media-roots/repository';
import { MediaRootId } from '../../src/lib/shared/contracts/ids';
import { TestDatabase } from './support/database';

function root(path: string): NewMediaRoot {
  return { id: MediaRootId.make(randomUUID()), path, displayName: path.split('/').at(-1) ?? path, mediaType: 'video' };
}

const reset = TestDatabase.truncate('media_roots', 'scan_runs');

layer(MediaRootRepository.layer.pipe(Layer.provideMerge(TestDatabase.layer)), { excludeTestServices: true })(
  'MediaRootRepository on PostgreSQL',
  (it) => {
    it.effect('appends roots after the highest display order', () =>
      Effect.gen(function* () {
        yield* reset;
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* MediaRootRepository.Service;
        yield* sql`insert into media_roots (id, path, display_name, media_type, display_order)
          values (${randomUUID()}, '/existing', 'Existing', 'video', 7)`;
        expect(yield* repository.insertIfNoOverlap(root('/library'))).toMatchObject({
          path: '/library',
          displayOrder: 8,
        });
        expect(yield* sql`select path, display_order from media_roots order by display_order`).toEqual([
          { path: '/existing', display_order: 7 },
          { path: '/library', display_order: 8 },
        ]);
      }),
    );

    it.effect('rejects roots that overlap existing ones, including case variants of Windows paths', () =>
      Effect.gen(function* () {
        yield* reset;
        const repository = yield* MediaRootRepository.Service;
        yield* repository.insertIfNoOverlap(root('C:\\Media\\Anime'));
        for (const path of ['C:\\Media', 'c:\\media\\anime', 'C:\\MEDIA\\Anime\\Frieren']) {
          expect(yield* Effect.flip(repository.insertIfNoOverlap(root(path)))).toMatchObject({
            _tag: 'MediaRootOverlap',
          });
        }
      }),
    );

    it.effect('lets exactly one of many concurrent overlapping creations commit', () =>
      Effect.gen(function* () {
        yield* reset;
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* MediaRootRepository.Service;
        // Every pair in this chain overlaps (each path contains the next), so only one may win.
        const chain = Array.from({ length: 8 }, (_, depth) => `/library${'/nested'.repeat(depth)}`);
        const results = yield* Effect.forEach(
          chain,
          (path) => Effect.result(repository.insertIfNoOverlap(root(path))),
          {
            concurrency: 'unbounded',
          },
        );
        expect(results.filter((result) => result._tag === 'Success')).toHaveLength(1);
        for (const result of results)
          if (result._tag === 'Failure') expect(result.failure._tag).toBe('MediaRootOverlap');
        expect(yield* sql`select count(*)::int as count from media_roots`).toEqual([{ count: 1 }]);
      }),
    );

    it.effect('assigns unique display orders to concurrent non-overlapping creations', () =>
      Effect.gen(function* () {
        yield* reset;
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* MediaRootRepository.Service;
        const paths = Array.from({ length: 6 }, (_, index) => `/library-${index}`);
        yield* Effect.forEach(paths, (path) => repository.insertIfNoOverlap(root(path)), { concurrency: 'unbounded' });
        const orders = yield* sql<{
          display_order: number;
        }>`select display_order from media_roots order by display_order`;
        expect(orders.map((row) => row.display_order)).toEqual([0, 1, 2, 3, 4, 5]);
      }),
    );

    it.effect('reports an unreachable database as DatabaseUnavailable', () =>
      Effect.gen(function* () {
        // Fresh: the block's layer already built these layers, and would be reused otherwise.
        const unreachable = Layer.fresh(MediaRootRepository.layer).pipe(
          Layer.provide(Layer.fresh(Database.layer)),
          Layer.provide(
            PgClient.layer({
              url: Redacted.make('postgres://fern:fern@127.0.0.1:1/fern'),
              connectTimeout: '2 seconds',
            }),
          ),
          Layer.orDie,
        );
        const error = yield* MediaRootRepository.Service.use((repository) =>
          repository.insertIfNoOverlap(root('/unreachable')),
        ).pipe(Effect.provide(unreachable), Effect.flip);
        expect(error).toMatchObject({ _tag: 'DatabaseUnavailable' });
      }),
    );

    it.effect('removes a root with everything indexed under it', () =>
      Effect.gen(function* () {
        yield* reset;
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* MediaRootRepository.Service;
        const created = root('/removable');
        yield* repository.insertIfNoOverlap(created);
        yield* sql`insert into media_entries (id, media_root_id, relative_path, name, kind, mtime_ms)
          values (${randomUUID()}, ${created.id}, 'a', 'a', 'directory', 0)`;
        yield* repository.remove(created.id);
        expect(yield* sql`select id from media_entries`).toEqual([]);
        expect(yield* Effect.flip(repository.remove(created.id))).toMatchObject({ _tag: 'MediaRootNotFound' });
      }),
    );

    it.effect('refuses to remove a root while a scan is active', () =>
      Effect.gen(function* () {
        yield* reset;
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* MediaRootRepository.Service;
        const created = root('/scanning');
        yield* repository.insertIfNoOverlap(created);
        yield* sql`insert into scan_runs (id, state) values (${randomUUID()}, 'running')`;
        expect(yield* Effect.flip(repository.remove(created.id))).toMatchObject({ _tag: 'MediaRootBusy' });
        expect(yield* sql`select id from media_roots`).toHaveLength(1);
      }),
    );

    it.effect('creates the YouTube library once, after the other roots, and moves it with its folder', () =>
      Effect.gen(function* () {
        yield* reset;
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* MediaRootRepository.Service;
        yield* repository.insertIfNoOverlap(root('/media'));
        const first = yield* repository.ensureYouTubeRoot('/downloads');
        expect(yield* repository.ensureYouTubeRoot('/downloads')).toBe(first);
        expect(
          yield* sql`select path, display_name, media_type, source, display_order from media_roots
            where source = 'youtube'`,
        ).toEqual([
          { path: '/downloads', display_name: 'YouTube', media_type: 'music', source: 'youtube', display_order: 1 },
        ]);

        expect(yield* repository.ensureYouTubeRoot('/srv/downloads')).toBe(first);
        expect(yield* sql`select path from media_roots where source = 'youtube'`).toEqual([{ path: '/srv/downloads' }]);
      }),
    );

    it.effect('keeps the YouTube library out of media folders, and refuses to remove it', () =>
      Effect.gen(function* () {
        yield* reset;
        const repository = yield* MediaRootRepository.Service;
        yield* repository.insertIfNoOverlap(root('/media'));
        expect(yield* Effect.flip(repository.ensureYouTubeRoot('/media/downloads'))).toMatchObject({
          _tag: 'MediaRootOverlap',
        });
        const youtube = yield* repository.ensureYouTubeRoot('/downloads');
        expect(yield* Effect.flip(repository.insertIfNoOverlap(root('/downloads/mixes')))).toMatchObject({
          _tag: 'MediaRootOverlap',
        });
        expect(yield* Effect.flip(repository.remove(youtube))).toMatchObject({ _tag: 'MediaRootManaged' });
      }),
    );
  },
);
