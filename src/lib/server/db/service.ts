import { PgClient } from '@effect/sql-pg';
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core/errors';
import * as PgDrizzle from 'drizzle-orm/effect-postgres';
import { Cause, Context, Data, Effect, Layer } from 'effect';
import { isSqlError, type SqlError, type SqlErrorReason } from 'effect/unstable/sql/SqlError';
import { FernConfig } from '$lib/server/config';

/** Drizzle over Fern's Effect PostgreSQL client. Queries and transactions are Effects. */
export type FernDatabase = Effect.Success<ReturnType<typeof PgDrizzle.makeWithDefaults>>;

/** A transaction on the Fern database, as passed to `db.transaction` callbacks. */
export type FernTransaction = Parameters<Parameters<FernDatabase['transaction']>[0]>[0];

/** Connections the application pool may open. Zero's mutation pool is separate (see `ZeroServer`). */
const MAX_CONNECTIONS = 10;

/** The PostgreSQL client for `DATABASE_URL`. Connections open on first use, so startup never waits on the database. */
const PgClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const { DATABASE_URL } = yield* FernConfig;
    return PgClient.layer({ url: DATABASE_URL, maxConnections: MAX_CONNECTIONS, applicationName: 'fern' });
  }),
).pipe(Layer.orDie);

/** The Drizzle database. Provided by the application runtime, or by a test database in tests. */
export class Database extends Context.Service<Database, FernDatabase>()('fern/Database') {
  /** Requires a `PgClient`. */
  static readonly layerWithoutDependencies = Layer.effect(this, PgDrizzle.makeWithDefaults());
  /** Requires `FernConfig`. */
  static readonly layer = this.layerWithoutDependencies.pipe(Layer.provideMerge(PgClientLive));
}

/** PostgreSQL cannot be reached or refused the connection. Maps to 503. */
export class DatabaseUnavailable extends Data.TaggedError('DatabaseUnavailable')<{ readonly cause: unknown }> {}

/** What a query or transaction can fail with before classification. */
type QueryError = EffectDrizzleQueryError | SqlError;

const isQueryError = (error: unknown): error is QueryError =>
  error instanceof EffectDrizzleQueryError || isSqlError(error);

/** The classified reason behind a failed query. */
function sqlReason(error: QueryError): SqlErrorReason | undefined {
  if (isSqlError(error)) return error.reason;
  const inner = Cause.isCause(error.cause) ? Cause.squash(error.cause) : error.cause;
  return isSqlError(inner) ? inner.reason : undefined;
}

/** The constraint a failed statement violated, when it was a unique violation. */
export function uniqueViolation(error: QueryError): string | undefined {
  const reason = sqlReason(error);
  return reason?._tag === 'UniqueViolation' ? reason.constraint : undefined;
}

// SQLSTATE classes 08 (connection exception), 53300 (too many connections), and 57P01–57P03
// (server shutting down or not yet accepting connections).
const unavailableStates = /^(08...|53300|57P0[123])$/;

function isUnavailable(reason: SqlErrorReason | undefined) {
  if (!reason) return false;
  if (reason._tag === 'ConnectionError' || reason._tag === 'AuthenticationError') return true;
  const code = (reason.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && unavailableStates.test(code);
}

/**
 * Classifies database failures: connectivity problems fail with `DatabaseUnavailable`, and any
 * other query failure is a defect. Handle expected failures, such as a unique violation, first.
 */
export const orUnavailable = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, QueryError> | DatabaseUnavailable, R> =>
  // The refinement removes QueryError from E, but TypeScript cannot narrow a generic E itself.
  Effect.catchIf(self, isQueryError, (error) =>
    isUnavailable(sqlReason(error)) ? Effect.fail(new DatabaseUnavailable({ cause: error })) : Effect.die(error),
  ) as Effect.Effect<A, Exclude<E, QueryError> | DatabaseUnavailable, R>;

/** `orUnavailable` for a statement that uses the `Database` service. */
export const query = <A, E>(
  run: (db: FernDatabase) => Effect.Effect<A, E>,
): Effect.Effect<A, Exclude<E, QueryError> | DatabaseUnavailable, Database> =>
  orUnavailable(
    Effect.gen(function* () {
      return yield* run(yield* Database);
    }),
  );
