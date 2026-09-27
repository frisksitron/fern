import { open, stat } from 'node:fs/promises';
import { Effect } from 'effect';
import { MediaFileUnavailable } from './errors';

// Files are resolved and verified by MediaLibrary first; these report a file that disappeared since.

export function fileStats(file: string) {
  return Effect.tryPromise({
    try: () => stat(file),
    catch: () => new MediaFileUnavailable({ path: file, reason: 'missing' }),
  });
}

/** Opens a file for a streamed response body, which closes the handle when it finishes. */
export function openFile(file: string) {
  return Effect.tryPromise({
    try: () => open(file, 'r'),
    catch: () => new MediaFileUnavailable({ path: file, reason: 'missing' }),
  });
}
