import { Clock, Context, Deferred, Duration, Effect, Fiber, FiberSet, Schema, Semaphore } from 'effect';

/** Every slot is busy and the waiting list is full, or the wait took too long. Maps to 503 + Retry-After. */
export class CapacityExceeded extends Schema.TaggedError<CapacityExceeded>()('CapacityExceeded', {
  retryAfterSeconds: Schema.Number,
}) {}

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
export const makeCapacity = Effect.fnUntraced(function* (options: CapacityOptions) {
  const permits = yield* Semaphore.make(options.concurrency);
  const exceeded = new CapacityExceeded({ retryAfterSeconds: options.retryAfterSeconds ?? 2 });
  let waiting = 0;

  const withCapacity = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | CapacityExceeded, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!(yield* permits.takeIfAvailable(1))) {
          if (waiting >= options.maxWaiting) return yield* exceeded;
          waiting++;
          yield* restore(
            permits
              .take(1)
              .pipe(Effect.timeoutOrElse({ duration: options.maxWait, orElse: () => Effect.fail(exceeded) })),
          ).pipe(Effect.ensuring(Effect.sync(() => waiting--)));
        }
        return yield* restore(effect).pipe(Effect.ensuring(permits.release(1)));
      }),
    );

  return { withCapacity, waiting: () => waiting };
});

/**
 * Starts `work` in the background at most once per `interval`, however often it is requested, and
 * never twice at once. For maintenance that requests trigger, such as cache eviction. The fibers
 * belong to the caller's scope.
 */
export const makeThrottled = Effect.fnUntraced(function* (work: Effect.Effect<void>, interval: Duration.Input) {
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

type InFlight<E> = {
  readonly deferred: Deferred.Deferred<void, E>;
  waiters: number;
  fiber?: Fiber.Fiber<void>;
  /** Counts down the grace period after the last waiter left. */
  grace?: Fiber.Fiber<void>;
};

/**
 * How long shared work keeps running after its last requester leaves. Clients retry a slow
 * request, and the retry should find the work still running instead of starting it over. Tests
 * shorten it.
 */
export const SharedWorkGrace = Context.Reference<Duration.Input>('fern/SharedWorkGrace', {
  defaultValue: () => '15 seconds',
});

/**
 * Runs keyed work once for every concurrent requester. The work runs in a fiber owned by the
 * caller's scope. When the last requester goes away (its request was abandoned), the work gets a
 * grace period (`SharedWorkGrace`) for a new requester to attach to it; after that it is
 * interrupted so no process keeps running for nobody. Entries are removed on success, failure,
 * and interruption alike, and closing the scope interrupts everything at once.
 */
// A plain function rather than `Effect.fnUntraced`, which would erase the error type parameter.
export function makeSharedWork<E>() {
  return Effect.gen(function* () {
    const fibers = yield* FiberSet.make<void>();
    const inFlight = new Map<string, InFlight<E>>();
    const grace = Duration.fromInputUnsafe(yield* SharedWorkGrace);

    /** Starts the work for `key` in a fiber that settles the entry's deferred and then forgets it. */
    const start = Effect.fnUntraced(function* (key: string, work: Effect.Effect<void, E>) {
      const created: InFlight<E> = { deferred: yield* Deferred.make<void, E>(), waiters: 0 };
      inFlight.set(key, created);
      created.fiber = yield* FiberSet.run(
        fibers,
        work.pipe(
          Effect.onExit((exit) => Deferred.done(created.deferred, exit)),
          Effect.ensuring(
            Effect.suspend(() => {
              if (inFlight.get(key) === created) inFlight.delete(key);
              return created.grace ? Fiber.interrupt(created.grace) : Effect.void;
            }),
          ),
          Effect.ignore,
        ),
      );
      return created;
    });

    /** Forgets the entry and interrupts its work, unless a requester came back in the meantime. */
    const abandon = (key: string, entry: InFlight<E>) =>
      Effect.suspend(() => {
        if (entry.waiters > 0 || inFlight.get(key) !== entry || !entry.fiber) return Effect.void;
        inFlight.delete(key);
        entry.grace = undefined;
        return Fiber.interrupt(entry.fiber);
      });

    /** Stops waiting; once the last requester has left, the work is interrupted after the grace period. */
    const leave = (key: string, entry: InFlight<E>) =>
      Effect.suspend(() => {
        entry.waiters--;
        if (entry.waiters > 0 || inFlight.get(key) !== entry || !entry.fiber) return Effect.void;
        if (Duration.isZero(grace)) return abandon(key, entry);
        return FiberSet.run(
          fibers,
          Effect.sleep(grace).pipe(Effect.andThen(abandon(key, entry)), Effect.interruptible),
        ).pipe(
          Effect.map((fiber) => {
            entry.grace = fiber;
          }),
        );
      });

    /** Counts a requester in, stopping the countdown of a grace period it arrived during. */
    const join = (entry: InFlight<E>) =>
      Effect.suspend(() => {
        entry.waiters++;
        const countdown = entry.grace;
        entry.grace = undefined;
        return countdown ? Fiber.interrupt(countdown) : Effect.void;
      });

    const run = (key: string, work: Effect.Effect<void, E>): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = inFlight.get(key) ?? (yield* start(key, work));
          yield* join(entry);
          return yield* restore(Deferred.await(entry.deferred)).pipe(Effect.ensuring(leave(key, entry)));
        }),
      );

    return { run, inFlightKeys: () => [...inFlight.keys()] };
  });
}
