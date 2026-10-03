import { Effect, Option } from 'effect';
import type { SqlClient } from 'effect/sql/SqlClient';
import { orUnavailable, type DatabaseUnavailable } from '$lib/server/db/service';

/** The advisory lock key held by the one process that runs scans ("fern" in ASCII). */
export const SCAN_WORKER_LOCK = 0x6665726e;

export type Leadership = {
  /** Fails when the lock's connection no longer answers, which means the lock is gone. */
  readonly check: Effect.Effect<void, DatabaseUnavailable>;
};

/**
 * Tries to take a session-level advisory lock on a reserved connection. The lock is held until the
 * scope closes or the connection drops; PostgreSQL releases it when the holder's session ends, so a
 * crashed process never keeps it. Returns `None` when another process holds it.
 */
export const tryLeadership = Effect.fnUntraced(function* (client: SqlClient, key: number = SCAN_WORKER_LOCK) {
  const connection = yield* orUnavailable(client.reserve);
  const [row] = yield* orUnavailable(
    connection.execute('select pg_try_advisory_lock($1) as acquired', [key], undefined),
  );
  if (!(row as { acquired?: boolean } | undefined)?.acquired) return Option.none<Leadership>();
  // Unlock before the connection goes back to the pool. A broken connection has lost the lock already.
  yield* Effect.addFinalizer(() =>
    connection.execute('select pg_advisory_unlock($1)', [key], undefined).pipe(Effect.ignore),
  );
  return Option.some<Leadership>({
    check: orUnavailable(connection.execute('select 1', [], undefined)).pipe(Effect.asVoid),
  });
});
