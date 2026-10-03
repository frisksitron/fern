import { Data } from 'effect';

/** The text is not a link to one YouTube video. */
export class InvalidYouTubeUrl extends Data.TaggedError('InvalidYouTubeUrl')<{ readonly url: string }> {}

/** The video is already waiting, downloading, or being added to the library. */
export class YouTubeDownloadActive extends Data.TaggedError('YouTubeDownloadActive')<{ readonly videoId: string }> {}

export class YouTubeDownloadNotFound extends Data.TaggedError('YouTubeDownloadNotFound')<{ readonly id: string }> {}

/** Only failed downloads can be retried. */
export class YouTubeDownloadNotFailed extends Data.TaggedError('YouTubeDownloadNotFailed')<{ readonly id: string }> {}

/**
 * The YouTube library cannot be used: `DOWNLOADS_DIR` cannot be created or written, it overlaps a
 * media folder, or the database is unavailable.
 */
export class YouTubeLibraryUnavailable extends Data.TaggedError('YouTubeLibraryUnavailable')<{
  readonly cause: unknown;
}> {}
