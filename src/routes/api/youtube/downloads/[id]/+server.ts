import { Effect, Schema } from 'effect';
import { decodeInput, respond } from '$lib/server/http';
import { youtubeFailure } from '$lib/server/youtube/http';
import { YouTubeDownloads } from '$lib/server/youtube/service';
import { YouTubeDownloadId } from '$lib/shared/contracts/ids';
import type { RequestHandler } from './$types';

const decodeParams = Schema.decodeUnknownEffect(Schema.Struct({ id: YouTubeDownloadId }));

/** Removes a download from the list, stopping it if it runs. A saved song stays in the library. */
export const DELETE: RequestHandler = ({ params, request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id } = yield* decodeInput(params, decodeParams);
      yield* YouTubeDownloads.Service.use((downloads) => downloads.dismiss(id));
    }),
    { success: () => new Response(null, { status: 204 }), failure: youtubeFailure },
  );
