import { randomBytes } from 'node:crypto';
import { PgClient } from '@effect/sql-pg';
import { Effect, Layer, ManagedRuntime, Redacted } from 'effect';
import pg from 'pg';
import { inject } from 'vitest';
import { Database, type FernDatabase } from '../../../src/lib/server/db/service';
import { databaseUrl, dropDatabase, quoteIdentifier, withAdminClient } from './postgres';

export type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

/** Creates an isolated, fully migrated database cloned from the run's template. */
export async function createTestDatabase() {
  const name = `fern_test_${randomBytes(8).toString('hex')}`;
  const template = inject('templateDatabase');
  await withAdminClient((client) =>
    client.query(`create database ${quoteIdentifier(name)} template ${quoteIdentifier(template)}`),
  );
  const url = databaseUrl(name);
  /** The application's `Database` (and its `PgClient`) on this database, as services use it. */
  const layer = Database.layerWithoutDependencies.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 5 })),
    Layer.orDie,
  );
  const runtime = ManagedRuntime.make(layer);
  // Plain node-postgres for fixtures and assertions that are clearer in SQL.
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return {
    name,
    url,
    pool,
    layer,
    /** Runs a program that uses the database, such as a query or a loader. */
    run: <A, E>(program: Effect.Effect<A, E, Database | PgClient.PgClient>) => runtime.runPromise(program),
    /** Runs one Drizzle statement or transaction. */
    query: <A, E>(statement: (db: FernDatabase) => Effect.Effect<A, E>) =>
      runtime.runPromise(
        Effect.gen(function* () {
          return yield* statement(yield* Database);
        }),
      ),
    async drop() {
      await runtime.dispose();
      await pool.end();
      await dropDatabase(name);
    },
  };
}
