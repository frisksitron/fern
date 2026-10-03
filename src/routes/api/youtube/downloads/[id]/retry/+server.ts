import { Effect, Schema } from 'effect';
import { decodeInput, respond } from '$lib/server/http';
import { youtubeFailure } from '$lib/server/youtube/http';
import { YouTubeDownloads } from '$lib/server/youtube/service';
import { YouTubeDownloadId } from '$lib/shared/contracts/ids';
import type { RequestHandler } from './$types';

const decodeParams = Schema.decodeUnknownEffect(Schema.Struct({ id: YouTubeDownloadId }));

/** Queues a failed download again. */
export const POST: RequestHandler = ({ params, request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id } = yield* decodeInput(params, decodeParams);
      yield* YouTubeDownloads.use((downloads) => downloads.retry(id));
    }),
    { success: () => new Response(null, { status: 202 }), failure: youtubeFailure },
  );
