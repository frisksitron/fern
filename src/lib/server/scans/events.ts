import { Context, Effect, Layer, PubSub, Stream } from 'effect';
import type { ScanId } from '$lib/shared/contracts/ids';
import type { ScanEvent } from '$lib/shared/contracts/scans';

export type ScanEventEnvelope = { readonly scanId: ScanId; readonly event: ScanEvent };

/** Delivers scan events from the scanner to live subscribers (server-sent event streams) in this process. */
export class ScanEvents extends Context.Service<ScanEvents>()('fern/ScanEvents', {
  make: Effect.gen(function* () {
    const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<ScanEventEnvelope>(), (hub) => PubSub.shutdown(hub));

    const publish = (scanId: ScanId, event: ScanEvent) => PubSub.publish(pubsub, { scanId, event }).pipe(Effect.asVoid);

    /**
     * Subscribes now, in the caller's scope, and returns the scan's events as a stream. Subscribing
     * before reading a scan's stored state means no event can fall between the two.
     */
    const subscribe = (scanId: ScanId) =>
      Effect.map(PubSub.subscribe(pubsub), (subscription) =>
        Stream.fromSubscription(subscription).pipe(
          Stream.filter((envelope) => envelope.scanId === scanId),
          Stream.map((envelope) => envelope.event),
        ),
      );

    return { publish, subscribe } as const;
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
