import { Effect, Schema } from 'effect';
import { decodeInput, respond } from '$lib/server/http';
import { trackMapFailure } from '$lib/server/track-maps/http';
import { TrackMaps } from '$lib/server/track-maps/service';
import { MediaEntryId } from '$lib/shared/contracts/ids';
import type { RequestHandler } from './$types';

const decodeParams = Schema.decodeUnknownEffect(Schema.Struct({ id: MediaEntryId }));

/** The track's map for the music visual effects (`TrackMapResponse`), analysed on first request. */
export const GET: RequestHandler = ({ params, request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id } = yield* decodeInput(params, decodeParams);
      return yield* TrackMaps.use((trackMaps) => trackMaps.trackMapOf(id));
    }),
    {
      success: (trackMap) =>
        new Response(new Uint8Array(trackMap.contents), {
          headers: {
            'content-type': 'application/json',
            'cache-control': 'private, no-cache',
            etag: `"${trackMap.key}"`,
          },
        }),
      failure: trackMapFailure,
    },
  );
