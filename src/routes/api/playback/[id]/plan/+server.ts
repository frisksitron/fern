import { Effect, Schema } from 'effect';
import { decodeInput, jsonResponse, respond } from '$lib/server/http';
import { playbackFailure } from '$lib/server/playback/http';
import { Playback } from '$lib/server/playback/service';
import { MediaEntryId } from '$lib/shared/contracts/ids';
import { PlaybackPlan } from '$lib/shared/contracts/playback';
import type { RequestHandler } from './$types';

const decodeParams = Schema.decodeUnknownEffect(Schema.Struct({ id: MediaEntryId }));

export const GET: RequestHandler = ({ params, request, url }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id } = yield* decodeInput(params, decodeParams);
      // Clients opt out of codecs they cannot play; anything but "false" means supported.
      const capabilities = {
        h264: url.searchParams.get('h264') !== 'false',
        aac: url.searchParams.get('aac') !== 'false',
        webm: url.searchParams.get('webm') !== 'false',
      };
      const plan = yield* Playback.Service.use((playback) => playback.plan(id, capabilities));
      return yield* jsonResponse(PlaybackPlan, plan);
    }),
    { success: (response) => response, failure: playbackFailure },
  );
