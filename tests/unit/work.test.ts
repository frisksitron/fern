import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { makeCapacity, makeSharedWork } from '../../src/lib/server/media/work';

describe('makeSharedWork', () => {
  it.effect('runs keyed work once for concurrent requesters', () =>
    Effect.gen(function* () {
      let runs = 0;
      const shared = yield* makeSharedWork<never>();
      const gate = yield* Deferred.make<void>();
      const work = Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate)));
      const requesters = yield* Effect.forEach([1, 2, 3], () => Effect.forkChild(shared.run('segment-1', work)));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Effect.forEach(requesters, Fiber.join);
      expect(shared.inFlightKeys()).toEqual([]);
      expect(runs).toBe(1);
    }),
  );

  it.effect(
    'interrupts the work, running its finalizers, once every requester has left and the grace period ends',
    () =>
      Effect.gen(function* () {
        let cleanedUp = false;
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
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(first);
        yield* Fiber.interrupt(second);
        yield* TestClock.adjust('14 seconds');
        expect(cleanedUp).toBe(false);
        expect(shared.inFlightKeys()).toEqual(['segment-1']);
        yield* TestClock.adjust('1 second');
        expect(cleanedUp).toBe(true);
        expect(shared.inFlightKeys()).toEqual([]);
      }),
  );

  it.effect('lets a requester that arrives during the grace period attach to the running work', () =>
    Effect.gen(function* () {
      let runs = 0;
      let cleanedUp = false;
      const shared = yield* makeSharedWork<never>();
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const work = Effect.sync(() => runs++).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(gate)),
        Effect.ensuring(Effect.sync(() => (cleanedUp = true))),
      );
      const abandoned = yield* Effect.forkChild(shared.run('segment-1', work));
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(abandoned);
      yield* TestClock.adjust('10 seconds');
      const retry = yield* Effect.forkChild(shared.run('segment-1', work));
      yield* Effect.yieldNow;
      // Past the first requester's grace period, which the retry cancelled.
      yield* TestClock.adjust('10 seconds');
      expect(cleanedUp).toBe(false);
      yield* Deferred.succeed(gate, undefined);
      expect(Exit.isSuccess(yield* Fiber.await(retry))).toBe(true);
      expect(runs).toBe(1);
      expect(shared.inFlightKeys()).toEqual([]);
    }),
  );

  it.effect('starts the grace period over each time the last requester leaves', () =>
    Effect.gen(function* () {
      let cleanedUp = false;
      const shared = yield* makeSharedWork<never>();
      const started = yield* Deferred.make<void>();
      const work = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => (cleanedUp = true))),
      );
      const first = yield* Effect.forkChild(shared.run('segment-1', work));
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      yield* TestClock.adjust('10 seconds');
      const second = yield* Effect.forkChild(shared.run('segment-1', work));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(second);
      yield* TestClock.adjust('10 seconds');
      expect(cleanedUp).toBe(false);
      yield* TestClock.adjust('5 seconds');
      expect(cleanedUp).toBe(true);
    }),
  );

  it.effect('interrupts work still in its grace period as soon as the owning scope closes', () =>
    Effect.gen(function* () {
      let cleanedUp = false;
      const started = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const shared = yield* makeSharedWork<never>();
        const work = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => (cleanedUp = true))),
        );
        const requester = yield* Effect.forkChild(shared.run('segment-1', work));
        yield* Deferred.await(started);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(requester);
        expect(cleanedUp).toBe(false);
      }).pipe(Effect.scoped);
      expect(cleanedUp).toBe(true);
    }),
  );

  it.effect('keeps working for the requesters that remain', () =>
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

  it.effect('shares failures and forgets them, so a later request retries', () =>
    Effect.gen(function* () {
      let attempts = 0;
      const shared = yield* makeSharedWork<string>();
      const failing = Effect.sync(() => attempts++).pipe(Effect.andThen(Effect.fail('ffmpeg failed')));
      expect(yield* Effect.flip(shared.run('segment-1', failing))).toBe('ffmpeg failed');
      yield* Effect.flip(shared.run('segment-1', failing));
      expect(attempts).toBe(2);
    }),
  );
});

describe('makeCapacity', () => {
  it.effect('rejects requests once every slot is busy and the waiting list is full', () =>
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

  it.effect('gives up waiting after the maximum wait', () =>
    Effect.gen(function* () {
      const capacity = yield* makeCapacity({ concurrency: 1, maxWaiting: 4, maxWait: '20 seconds' });
      yield* Effect.forkChild(capacity.withCapacity(Effect.never));
      yield* Effect.yieldNow;
      const waiting = yield* Effect.forkChild(Effect.flip(capacity.withCapacity(Effect.void)));
      yield* Effect.yieldNow;
      yield* TestClock.adjust('20 seconds');
      expect(yield* Fiber.join(waiting)).toMatchObject({ _tag: 'CapacityExceeded' });
      expect(capacity.waiting()).toBe(0);
    }),
  );
});
