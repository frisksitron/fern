import { randomBytes } from 'node:crypto';
import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Redacted } from 'effect';
import { SqlClient } from 'effect/sql';
import { inject } from 'vitest';
import { Database } from '../../../src/lib/server/db/service';
import { databaseUrl, dropDatabase, quoteIdentifier, withAdminClient } from './postgres';

/** The disposable database a test block runs against. */
export class Service extends Context.Service<Service, { readonly name: string; readonly url: string }>()(
  'test/TestDatabase',
) {}

/** Clones the run's migrated template into a new database, dropped when the scope closes. */
const clone = Effect.acquireRelease(
  Effect.promise(async () => {
    const name = `fern_test_${randomBytes(8).toString('hex')}`;
    const template = inject('templateDatabase');
    await withAdminClient((client) =>
      client.query(`create database ${quoteIdentifier(name)} template ${quoteIdentifier(template)}`),
    );
    return { name, url: databaseUrl(name) };
  }),
  (database) => Effect.promise(() => dropDatabase(database.name)),
);

/**
 * An isolated, fully migrated database for a `layer(...)` block: the application's `Database` on
 * it, and its `SqlClient` for fixtures and assertions that read more clearly as plain SQL.
 */
export const layer = Layer.unwrap(
  Effect.map(clone, (database) =>
    Database.layer.pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(database.url), maxConnections: 5 })),
      Layer.orDie,
      Layer.merge(Layer.succeed(Service, database)),
    ),
  ),
);

/** Empties the given tables (and everything that references them), for a test that needs a clean slate. */
export const truncate = Effect.fnUntraced(function* (...tables: ReadonlyArray<string>) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`truncate ${tables.join(', ')} cascade`).pipe(Effect.orDie);
});

export * as TestDatabase from './database';
