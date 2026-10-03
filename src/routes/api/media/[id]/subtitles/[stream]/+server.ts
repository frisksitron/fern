import { Effect, Schema } from 'effect';
import { decodeInput, respond } from '$lib/server/http';
import { playbackFailure } from '$lib/server/playback/http';
import { Playback } from '$lib/server/playback/service';
import { MediaEntryId } from '$lib/shared/contracts/ids';
import type { RequestHandler } from './$types';

const decodeParams = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: MediaEntryId,
    stream: Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }),
);

/** An embedded text subtitle stream as WebVTT. */
export const GET: RequestHandler = ({ params, request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id, stream } = yield* decodeInput(params, decodeParams);
      return yield* Playback.Service.use((playback) => playback.embeddedSubtitle(id, stream));
    }),
    {
      success: (text) =>
        new Response(text, {
          headers: { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'private, max-age=3600' },
        }),
      failure: playbackFailure,
    },
  );
