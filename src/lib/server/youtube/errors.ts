import { Schema } from 'effect';

/** The text is not a link to one YouTube video. */
export class InvalidYouTubeUrl extends Schema.TaggedError<InvalidYouTubeUrl>()('InvalidYouTubeUrl', {
  url: Schema.String,
}) {}

/** The video is already waiting, downloading, or being added to the library. */
export class YouTubeDownloadActive extends Schema.TaggedError<YouTubeDownloadActive>()('YouTubeDownloadActive', {
  videoId: Schema.String,
}) {}

export class YouTubeDownloadNotFound extends Schema.TaggedError<YouTubeDownloadNotFound>()('YouTubeDownloadNotFound', {
  id: Schema.String,
}) {}

/** Only failed downloads can be retried. */
export class YouTubeDownloadNotFailed extends Schema.TaggedError<YouTubeDownloadNotFailed>()(
  'YouTubeDownloadNotFailed',
  { id: Schema.String },
) {}

/**
 * The YouTube library cannot be used: `DOWNLOADS_DIR` cannot be created or written, it overlaps a
 * media folder, or the database is unavailable.
 */
export class YouTubeLibraryUnavailable extends Schema.TaggedError<YouTubeLibraryUnavailable>()(
  'YouTubeLibraryUnavailable',
  { cause: Schema.Defect() },
) {}

/**
 * yt-dlp finished without reporting a saved file, or reported one Fern will not index: outside the
 * YouTube library, or in a hidden (dot) folder that scans skip.
 */
export class YouTubeSavedFileRejected extends Schema.TaggedError<YouTubeSavedFileRejected>()(
  'YouTubeSavedFileRejected',
  { path: Schema.NullOr(Schema.String) },
) {}
