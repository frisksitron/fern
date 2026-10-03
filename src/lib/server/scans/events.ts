import { Context, Effect, Layer, PubSub, type Scope, Stream } from 'effect';
import type { ScanId } from '$lib/shared/contracts/ids';
import type { ScanEvent } from '$lib/shared/contracts/scans';

export type ScanEventEnvelope = { readonly scanId: ScanId; readonly event: ScanEvent };

/** Delivers scan events from the scanner to live subscribers (server-sent event streams) in this process. */
export interface Interface {
  readonly publish: (scanId: ScanId, event: ScanEvent) => Effect.Effect<void>;
  /**
   * Subscribes now, in the caller's scope, and returns the scan's events as a stream. Subscribing
   * before reading a scan's stored state means no event can fall between the two.
   */
  readonly subscribe: (scanId: ScanId) => Effect.Effect<Stream.Stream<ScanEvent>, never, Scope.Scope>;
}

export class Service extends Context.Service<Service, Interface>()('@fern/ScanEvents') {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<ScanEventEnvelope>(), (hub) => PubSub.shutdown(hub));

    const publish = Effect.fn('ScanEvents.publish')(function* (scanId: ScanId, event: ScanEvent) {
      yield* PubSub.publish(pubsub, { scanId, event });
    });

    const subscribe = Effect.fn('ScanEvents.subscribe')(function* (scanId: ScanId) {
      const subscription = yield* PubSub.subscribe(pubsub);
      return Stream.fromSubscription(subscription).pipe(
        Stream.filter((envelope) => envelope.scanId === scanId),
        Stream.map((envelope) => envelope.event),
      );
    });

    return Service.of({ publish, subscribe });
  }),
);

/** The one hub of the runtime: the scanner publishes to it and event streams subscribe to it. */
export const defaultLayer = layer;

export * as ScanEvents from './events';
