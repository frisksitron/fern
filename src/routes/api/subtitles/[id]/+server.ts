import { Effect, Schema } from 'effect';
import { decodeInput, respond } from '$lib/server/http';
import { playbackFailure } from '$lib/server/playback/http';
import { Playback } from '$lib/server/playback/service';
import { SubtitleId } from '$lib/shared/contracts/ids';
import type { RequestHandler } from './$types';

const decodeParams = Schema.decodeUnknownEffect(Schema.Struct({ id: SubtitleId }));

/** An external subtitle file as WebVTT (SRT is converted). */
export const GET: RequestHandler = ({ params, request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id } = yield* decodeInput(params, decodeParams);
      return yield* Playback.use((playback) => playback.externalSubtitle(id));
    }),
    {
      success: (text) => new Response(text, { headers: { 'content-type': 'text/vtt; charset=utf-8' } }),
      failure: playbackFailure,
    },
  );
