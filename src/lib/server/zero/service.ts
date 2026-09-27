import { mustGetMutator, mustGetQuery } from '@rocicorp/zero';
import { handleMutateRequest, handleQueryRequest } from '@rocicorp/zero/server';
import { zeroNodePg } from '@rocicorp/zero/server/adapters/pg';
import { Context, Effect, Layer, Redacted } from 'effect';
import pg from 'pg';
import { FernConfig } from '$lib/server/config';
import { mutators } from '$lib/zero/mutators';
import { queries } from '$lib/zero/queries';
import { schema } from '$lib/zero/schema';

/** Connections for server mutators. Mutations are small, short transactions. */
const MUTATION_CONNECTIONS = 4;

/**
 * Zero's server endpoints: authoritative mutations and query transforms. Mutators run ZQL through
 * Zero's node-postgres adapter on a small pool of their own, closed when the runtime shuts down.
 */
export class ZeroServer extends Context.Service<ZeroServer>()('fern/ZeroServer', {
  make: Effect.gen(function* () {
    const { DATABASE_URL } = yield* FernConfig;
    const fork = yield* Effect.context<never>().pipe(Effect.map((context) => Effect.runForkWith(context)));
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const created = new pg.Pool({ connectionString: Redacted.value(DATABASE_URL), max: MUTATION_CONNECTIONS });
        // An idle connection that breaks emits `error` on the pool; unhandled, it would stop the process.
        created.on('error', (cause) => fork(Effect.logWarning('An idle Zero database connection failed', cause)));
        return created;
      }),
      (created) => Effect.promise(() => created.end()),
    );
    const dbProvider = zeroNodePg(schema, pool);

    const mutate = (request: Request) =>
      Effect.promise(() =>
        handleMutateRequest({
          dbProvider,
          handler: (transact) => transact((tx, name, args) => mustGetMutator(mutators, name).fn({ tx, args })),
          request,
          userID: null,
        }),
      ).pipe(Effect.withSpan('zero.mutate'));

    const query = (request: Request) =>
      Effect.promise(() =>
        handleQueryRequest({
          handler: (name, args) => mustGetQuery(queries, name).fn({ args }),
          schema,
          request,
          userID: null,
        }),
      ).pipe(Effect.withSpan('zero.query'));

    return { mutate, query } as const;
  }),
}) {
  /** Requires `FernConfig`. */
  static readonly layer = Layer.effect(this, this.make);
}
