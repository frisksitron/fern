import { Effect, FileSystem, Stream } from 'effect';
import { MediaFileUnavailable } from './errors';

// Files are resolved and verified by MediaLibrary or Transcoding first; these report a file that
// disappeared since.

/**
 * Bytes read at a time. Measured end to end, 1 MiB chunks served files 1.3–4× faster than Node's
 * own web streams, which read 16 KiB at a time, and with less CPU.
 */
const CHUNK_SIZE = 1024 * 1024;

/** The size of a file, in bytes. */
export const fileSize = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs
    .stat(file)
    .pipe(Effect.mapError(() => new MediaFileUnavailable({ path: file, reason: 'missing' })));
  return Number(info.size);
});

/**
 * A file's contents, or the inclusive byte range `start`–`end` of them, as a response body. The
 * file opens when the response starts and closes when it finishes or the client goes away. Callers
 * check the file first (`fileSize`), so one that disappears in between only ends the response early.
 */
export const fileBody = Effect.fnUntraced(function* (
  file: string,
  range?: { readonly start: number; readonly end: number },
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = fs.stream(
    file,
    range
      ? { chunkSize: CHUNK_SIZE, offset: range.start, bytesToRead: range.end - range.start + 1 }
      : { chunkSize: CHUNK_SIZE },
  );
  return yield* Stream.toReadableStreamEffect(
    contents.pipe(Stream.tapError((error) => Effect.logWarning('Media file stream failed', error))),
  );
});
