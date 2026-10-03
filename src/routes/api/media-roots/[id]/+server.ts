import { Effect, Schema } from 'effect';
import { decodeInput, respond } from '$lib/server/http';
import { removeMediaRootFailure } from '$lib/server/media-roots/http';
import { MediaRoots } from '$lib/server/media-roots/service';
import { MediaRootId } from '$lib/shared/contracts/ids';
import type { RequestHandler } from './$types';

const decodeParams = Schema.decodeUnknownEffect(Schema.Struct({ id: MediaRootId }));

/** Removes a media folder from the library. Refused with 409 while a scan is running. */
export const DELETE: RequestHandler = ({ params, request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id } = yield* decodeInput(params, decodeParams);
      yield* MediaRoots.Service.use((mediaRoots) => mediaRoots.remove(id));
    }),
    { success: () => new Response(null, { status: 204 }), failure: removeMediaRootFailure },
  );
