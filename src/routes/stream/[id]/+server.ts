import path from 'node:path';
import { Readable } from 'node:stream';
import { Effect, Schema } from 'effect';
import { decodeInput, respond } from '$lib/server/http';
import { fileStats, openFile } from '$lib/server/media/files';
import { mediaFailure } from '$lib/server/media/http';
import { MediaLibrary } from '$lib/server/media/library';
import { parseByteRange } from '$lib/server/media/ranges';
import { MediaEntryId } from '$lib/shared/contracts/ids';
import type { RequestEvent } from './$types';

const mimeTypes: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
};

const decodeParams = Schema.decodeUnknownEffect(Schema.Struct({ id: MediaEntryId }));

export function HEAD(event: RequestEvent) {
  return serve(event, true);
}

export function GET(event: RequestEvent) {
  return serve(event, false);
}

/** Serves the whole file or one byte range, so browsers can seek during direct play. */
function serve({ params, request }: RequestEvent, head: boolean) {
  return respond(
    request,
    Effect.gen(function* () {
      const { id } = yield* decodeInput(params, decodeParams);
      const media = yield* MediaLibrary.use((library) => library.activeMedia(id));
      const { size } = yield* fileStats(media.path);
      const headers = new Headers({
        'accept-ranges': 'bytes',
        'content-type': mimeTypes[path.extname(media.path).toLowerCase()] ?? 'application/octet-stream',
      });

      const rangeHeader = request.headers.get('range');
      if (!rangeHeader) {
        headers.set('content-length', String(size));
        if (head) return new Response(null, { headers });
        const handle = yield* openFile(media.path);
        return new Response(handle.readableWebStream({ autoClose: true }) as ReadableStream, { headers });
      }

      const range = parseByteRange(rangeHeader, size);
      if (!range) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
      headers.set('content-length', String(range.end - range.start + 1));
      if (head) return new Response(null, { status: 206, headers });
      const handle = yield* openFile(media.path);
      const body = Readable.toWeb(handle.createReadStream({ start: range.start, end: range.end, autoClose: true }));
      return new Response(body as ReadableStream, { status: 206, headers });
    }),
    { success: (response) => response, failure: mediaFailure },
  );
}
