import { Deferred, Effect, Exit, Fiber, type Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';
import { makeCapacity, makeSharedWork } from '../../src/lib/server/media/work';

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect));

describe('makeSharedWork', () => {
  it('runs keyed work once for concurrent requesters', async () => {
    let runs = 0;
    await run(
      Effect.gen(function* () {
        const shared = yield* makeSharedWork<never>();
        const gate = yield* Deferred.make<void>();
        const work = Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate)));
        const requesters = yield* Effect.forEach([1, 2, 3], () => Effect.forkChild(shared.run('segment-1', work)));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(gate, undefined);
        yield* Effect.forEach(requesters, (fiber) => Fiber.join(fiber));
        expect(shared.inFlightKeys()).toEqual([]);
      }),
    );
    expect(runs).toBe(1);
  });

  it('interrupts the work, running its finalizers, when every requester leaves', async () => {
    let cleanedUp = false;
    await run(
      Effect.gen(function* () {
        const shared = yield* makeSharedWork<never>();
        const started = yield* Deferred.make<void>();
        const work = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => (cleanedUp = true))),
        );
        const first = yield* Effect.forkChild(shared.run('segment-1', work));
        const second = yield* Effect.forkChild(shared.run('segment-1', work));
        yield* Deferred.await(started);
        // Let both requesters register before one leaves.
        yield* Effect.sleep('20 millis');
        yield* Fiber.interrupt(first);
        expect(cleanedUp).toBe(false);
        yield* Fiber.interrupt(second);
        expect(cleanedUp).toBe(true);
        expect(shared.inFlightKeys()).toEqual([]);
      }),
    );
  });

  it('keeps working for the requesters that remain', async () => {
    await run(
      Effect.gen(function* () {
        const shared = yield* makeSharedWork<never>();
        const gate = yield* Deferred.make<void>();
        const leaving = yield* Effect.forkChild(shared.run('segment-1', Deferred.await(gate)));
        const staying = yield* Effect.forkChild(shared.run('segment-1', Deferred.await(gate)));
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(leaving);
        yield* Deferred.succeed(gate, undefined);
        expect(Exit.isSuccess(yield* Fiber.await(staying))).toBe(true);
      }),
    );
  });

  it('shares failures and forgets them, so a later request retries', async () => {
    let attempts = 0;
    await run(
      Effect.gen(function* () {
        const shared = yield* makeSharedWork<string>();
        const failing = Effect.sync(() => attempts++).pipe(Effect.andThen(Effect.fail('ffmpeg failed')));
        expect(yield* Effect.flip(shared.run('segment-1', failing))).toBe('ffmpeg failed');
        yield* Effect.flip(shared.run('segment-1', failing));
      }),
    );
    expect(attempts).toBe(2);
  });
});

describe('makeCapacity', () => {
  it('rejects requests once every slot is busy and the waiting list is full', async () => {
    await run(
      Effect.gen(function* () {
        const capacity = yield* makeCapacity({ concurrency: 1, maxWaiting: 1, maxWait: '1 minute' });
        const gate = yield* Deferred.make<void>();
        const running = yield* Effect.forkChild(capacity.withCapacity(Deferred.await(gate)));
        yield* Effect.yieldNow;
        const waiting = yield* Effect.forkChild(capacity.withCapacity(Effect.succeed('second')));
        yield* Effect.yieldNow;
        expect(capacity.waiting()).toBe(1);
        expect(yield* Effect.flip(capacity.withCapacity(Effect.void))).toMatchObject({
          _tag: 'CapacityExceeded',
          retryAfterSeconds: 2,
        });
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(running);
        expect(yield* Fiber.join(waiting)).toBe('second');
        expect(capacity.waiting()).toBe(0);
      }),
    );
  });

  it('gives up waiting after the maximum wait', async () => {
    await run(
      Effect.gen(function* () {
        const capacity = yield* makeCapacity({ concurrency: 1, maxWaiting: 4, maxWait: '20 seconds' });
        yield* Effect.forkChild(capacity.withCapacity(Effect.never));
        yield* Effect.yieldNow;
        const waiting = yield* Effect.forkChild(Effect.flip(capacity.withCapacity(Effect.void)));
        yield* Effect.yieldNow;
        yield* TestClock.adjust('20 seconds');
        expect(yield* Fiber.join(waiting)).toMatchObject({ _tag: 'CapacityExceeded' });
        expect(capacity.waiting()).toBe(0);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});
