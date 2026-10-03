import { Effect, Schema } from 'effect';
import { jsonResponse, readJsonBody, respond } from '$lib/server/http';
import { youtubeFailure } from '$lib/server/youtube/http';
import { YouTubeDownloads } from '$lib/server/youtube/service';
import { StartYouTubeDownloadRequest, StartYouTubeDownloadResponse } from '$lib/shared/contracts/youtube';
import type { RequestHandler } from './$types';

const decodeBody = Schema.decodeUnknownEffect(StartYouTubeDownloadRequest);

/** Queues a YouTube video's audio for download into the YouTube library. */
export const POST: RequestHandler = ({ request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { url } = yield* readJsonBody(request, decodeBody);
      const downloadId = yield* YouTubeDownloads.use((downloads) => downloads.start(url));
      return yield* jsonResponse(StartYouTubeDownloadResponse, { downloadId }, { status: 202 });
    }),
    { success: (response) => response, failure: youtubeFailure },
  );
