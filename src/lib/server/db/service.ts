import { PgClient } from '@effect/sql-pg';
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core/errors';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Cause, Context, Effect, Layer, Schema } from 'effect';
import { isSqlError, type SqlError, type SqlErrorReason } from 'effect/sql/SqlError';
import { FernConfig } from '$lib/server/config';

/** Drizzle over Fern's Effect PostgreSQL client. Queries and transactions are Effects. */
export type Client = Effect.Success<ReturnType<typeof makeWithDefaults>>;

/** A transaction on the Fern database, as passed to `db.transaction` callbacks. */
export type Transaction = Parameters<Parameters<Client['transaction']>[0]>[0];

/** The Drizzle database. */
export class Service extends Context.Service<Service, Client>()('@fern/Database') {}

/** Connections the application pool may open. Zero's mutation pool is separate (see `ZeroServer`). */
const MAX_CONNECTIONS = 10;

/** Requires a `PgClient`, such as a test database's. */
export const layer = Layer.effect(Service, makeWithDefaults());

/**
 * The database at `DATABASE_URL`. Connections open on first use, so startup never waits on the
 * database.
 */
export const defaultLayer = layer.pipe(
  Layer.provide(
    Layer.unwrap(
      Effect.gen(function* () {
        const config = yield* FernConfig.Service;
        return PgClient.layer({ url: config.DATABASE_URL, maxConnections: MAX_CONNECTIONS, applicationName: 'fern' });
      }),
    ).pipe(Layer.orDie),
  ),
  Layer.provide(FernConfig.defaultLayer),
);

/** PostgreSQL cannot be reached or refused the connection. Maps to 503. */
export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()('DatabaseUnavailable', {
  cause: Schema.Defect(),
}) {}

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

/**
 * `orUnavailable` for a statement on the `Database` service, for read models (page loads and MCP
 * tools) that are plain functions rather than services.
 */
export const query = <A, E>(
  run: (db: Client) => Effect.Effect<A, E>,
): Effect.Effect<A, Exclude<E, QueryError> | DatabaseUnavailable, Service> => orUnavailable(Service.use(run));

export * as Database from './service';
