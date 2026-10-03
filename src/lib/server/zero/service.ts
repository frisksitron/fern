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

/** Zero's server endpoints: authoritative mutations and query transforms. */
export interface Interface {
  /** Zero's push endpoint: runs client mutations. Mutator errors are reported in the result. */
  readonly mutate: (request: Request) => Effect.Effect<Awaited<ReturnType<typeof handleMutateRequest>>>;
  /** Zero's query endpoint: transforms named queries into ZQL for zero-cache. */
  readonly query: (request: Request) => Effect.Effect<Awaited<ReturnType<typeof handleQueryRequest>>>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/ZeroServer') {}

/**
 * Requires `FernConfig`. Mutators run ZQL through Zero's node-postgres adapter on a small pool of
 * their own, closed when the layer is released.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* FernConfig.Service;
    // Runs the pool's error log on this layer's services, from outside any fiber.
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const created = new pg.Pool({
          connectionString: Redacted.value(config.DATABASE_URL),
          max: MUTATION_CONNECTIONS,
        });
        // An idle connection that breaks emits `error` on the pool; unhandled, it would stop the process.
        created.on('error', (cause) => runFork(Effect.logWarning('An idle Zero database connection failed', cause)));
        return created;
      }),
      (created) => Effect.promise(() => created.end()),
    );
    const dbProvider = zeroNodePg(schema, pool);

    const mutate = Effect.fn('ZeroServer.mutate')((request: Request) =>
      Effect.promise(() =>
        handleMutateRequest({
          dbProvider,
          handler: (transact) => transact((tx, name, args) => mustGetMutator(mutators, name).fn({ tx, args })),
          request,
          userID: null,
        }),
      ),
    );

    const query = Effect.fn('ZeroServer.query')((request: Request) =>
      Effect.promise(() =>
        handleQueryRequest({
          handler: (name, args) => mustGetQuery(queries, name).fn({ args }),
          schema,
          request,
          userID: null,
        }),
      ),
    );

    return Service.of({ mutate, query });
  }),
);

export const defaultLayer = layer.pipe(Layer.provide(FernConfig.defaultLayer));

export * as ZeroServer from './service';
