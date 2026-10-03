import { Effect, Schema } from 'effect';
import { decodeInput, jsonResponse, readJsonBody, respond } from '$lib/server/http';
import { playbackFailure } from '$lib/server/playback/http';
import { Playback } from '$lib/server/playback/service';
import { MediaEntryId } from '$lib/shared/contracts/ids';
import { CreateHlsSessionRequest, HlsSession } from '$lib/shared/contracts/playback';
import type { RequestHandler } from './$types';

const decodeParams = Schema.decodeUnknownEffect(Schema.Struct({ id: MediaEntryId }));
const decodeBody = Schema.decodeUnknownEffect(CreateHlsSessionRequest);

export const POST: RequestHandler = ({ params, request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id } = yield* decodeInput(params, decodeParams);
      const { audioStream } = yield* readJsonBody(request, decodeBody);
      const session = yield* Playback.Service.use((playback) => playback.startSession(id, audioStream ?? null));
      return yield* jsonResponse(HlsSession, session, { status: 201 });
    }),
    { success: (response) => response, failure: playbackFailure },
  );
