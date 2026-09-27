import { Clock, Data, Deferred, Duration, Effect, Fiber, FiberSet, Semaphore } from 'effect';

/** Every slot is busy and the waiting list is full, or the wait took too long. Maps to 503 + Retry-After. */
export class CapacityExceeded extends Data.TaggedError('CapacityExceeded')<{ readonly retryAfterSeconds: number }> {}

type CapacityOptions = {
  /** Runs allowed at once. */
  readonly concurrency: number;
  /** Requests allowed to wait for a slot; beyond this they fail immediately. */
  readonly maxWaiting: number;
  /** How long a request may wait for a slot. */
  readonly maxWait: Duration.Input;
  readonly retryAfterSeconds?: number;
};

/** Limits concurrent runs with a bounded, time-limited waiting list instead of an unbounded queue. */
export function makeCapacity(options: CapacityOptions) {
  return Effect.gen(function* () {
    const permits = yield* Semaphore.make(options.concurrency);
    const exceeded = new CapacityExceeded({ retryAfterSeconds: options.retryAfterSeconds ?? 2 });
    let waiting = 0;

    const withCapacity = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | CapacityExceeded, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (!(yield* permits.takeIfAvailable(1))) {
            if (waiting >= options.maxWaiting) return yield* Effect.fail(exceeded);
            waiting++;
            yield* restore(
              permits
                .take(1)
                .pipe(Effect.timeoutOrElse({ duration: options.maxWait, orElse: () => Effect.fail(exceeded) })),
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  waiting--;
                }),
              ),
            );
          }
          return yield* restore(effect).pipe(Effect.ensuring(permits.release(1)));
        }),
      );

    return { withCapacity, waiting: () => waiting };
  });
}

/**
 * Starts `work` in the background at most once per `interval`, however often it is requested, and
 * never twice at once. For maintenance that requests trigger, such as cache eviction. The fibers
 * belong to the caller's scope.
 */
export function makeThrottled(work: Effect.Effect<void>, interval: Duration.Input) {
  return Effect.gen(function* () {
    const background = yield* FiberSet.make<void>();
    const lock = yield* Semaphore.make(1);
    const intervalMs = Duration.toMillis(interval);
    let lastStartMs = Number.NEGATIVE_INFINITY;
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now - lastStartMs < intervalMs) return;
      lastStartMs = now;
      yield* FiberSet.run(background, lock.withPermitsIfAvailable(1)(work).pipe(Effect.asVoid));
    });
  });
}

type InFlight<E> = {
  readonly deferred: Deferred.Deferred<void, E>;
  waiters: number;
  fiber?: Fiber.Fiber<void>;
};

/**
 * Runs keyed work once for every concurrent requester. The work runs in a fiber owned by the
 * caller's scope; when the last requester goes away (its request was abandoned), the work is
 * interrupted so no process keeps running for nobody. Entries are removed on success, failure,
 * and interruption alike.
 */
export function makeSharedWork<E>() {
  return Effect.gen(function* () {
    const fibers = yield* FiberSet.make<void>();
    const inFlight = new Map<string, InFlight<E>>();

    const run = (key: string, work: Effect.Effect<void, E>): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let entry = inFlight.get(key);
          if (!entry) {
            const created: InFlight<E> = { deferred: yield* Deferred.make<void, E>(), waiters: 0 };
            inFlight.set(key, created);
            created.fiber = yield* FiberSet.run(
              fibers,
              work.pipe(
                Effect.onExit((exit) => Deferred.done(created.deferred, exit)),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (inFlight.get(key) === created) inFlight.delete(key);
                  }),
                ),
                Effect.ignore,
              ),
            );
            entry = created;
          }
          const current = entry;
          current.waiters++;
          return yield* restore(Deferred.await(current.deferred)).pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                current.waiters--;
                if (current.waiters > 0 || inFlight.get(key) !== current || !current.fiber) return Effect.void;
                inFlight.delete(key);
                return Fiber.interrupt(current.fiber);
              }),
            ),
          );
        }),
      );

    return { run, inFlightKeys: () => [...inFlight.keys()] };
  });
}
