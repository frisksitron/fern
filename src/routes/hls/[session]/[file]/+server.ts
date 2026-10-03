import { Effect } from 'effect';
import { respond } from '$lib/server/http';
import { fileBody, fileSize } from '$lib/server/media/files';
import { transcodeFailure } from '$lib/server/transcoding/http';
import { Transcoding } from '$lib/server/transcoding/service';
import type { RequestHandler } from './$types';

/** HLS manifests and segments. Segments are transcoded on first request and then served from the cache. */
export const GET: RequestHandler = ({ params, request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const file = yield* Transcoding.Service.use((transcoding) => transcoding.hlsFile(params.session, params.file));
      const size = yield* fileSize(file);
      const isManifest = params.file.endsWith('.m3u8');
      return new Response(yield* fileBody(file), {
        headers: {
          'content-type': isManifest ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
          'content-length': String(size),
          'cache-control': isManifest ? 'no-cache' : 'public, max-age=31536000, immutable',
        },
      });
    }),
    { success: (response) => response, failure: transcodeFailure },
  );
