import { Effect, Schema } from 'effect';
import { decodeInput, respond } from '$lib/server/http';
import { fileStats, openFile } from '$lib/server/media/files';
import { mediaFailure } from '$lib/server/media/http';
import { MediaLibrary } from '$lib/server/media/library';
import { MediaEntryId } from '$lib/shared/contracts/ids';
import type { RequestHandler } from './$types';

const mimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const decodeParams = Schema.decodeUnknownEffect(Schema.Struct({ id: MediaEntryId }));

export const GET: RequestHandler = ({ params, request }) =>
  respond(
    request,
    Effect.gen(function* () {
      const { id } = yield* decodeInput(params, decodeParams);
      const artwork = yield* MediaLibrary.use((library) => library.artwork(id));
      const { size } = yield* fileStats(artwork.path);
      const etag = `"${artwork.id}-${artwork.mtimeMs}-${size}"`;
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      const handle = yield* openFile(artwork.path);
      return new Response(handle.readableWebStream({ autoClose: true }) as ReadableStream, {
        headers: {
          'content-type': mimeTypes[artwork.extension ?? ''] ?? 'application/octet-stream',
          'content-length': String(size),
          'cache-control': 'private, no-cache',
          etag,
        },
      });
    }),
    { success: (response) => response, failure: mediaFailure },
  );
