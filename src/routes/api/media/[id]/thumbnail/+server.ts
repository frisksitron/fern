import { Effect, Schema } from 'effect';
import { decodeInput, respond } from '$lib/server/http';
import { Thumbnails } from '$lib/server/thumbnails/service';
import { transcodeFailure } from '$lib/server/transcoding/http';
import { MediaEntryId } from '$lib/shared/contracts/ids';
import type { RequestHandler } from './$types';

const decodeRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    id: MediaEntryId,
    positionMs: Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

/** A JPEG frame at `positionMs` (0 when absent), clamped to the media's duration. */
export const GET: RequestHandler = ({ params, request, url }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id, positionMs } = yield* decodeInput(
        { id: params.id, positionMs: url.searchParams.get('positionMs') ?? '0' },
        decodeRequest,
      );
      return yield* Thumbnails.Service.use((thumbnails) => thumbnails.thumbnailAt(id, positionMs));
    }),
    {
      success: (thumbnail) =>
        new Response(new Uint8Array(thumbnail.contents), {
          headers: {
            'content-type': 'image/jpeg',
            'cache-control': 'private, no-cache',
            etag: `"${thumbnail.key}"`,
          },
        }),
      failure: transcodeFailure,
    },
  );
