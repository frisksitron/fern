import { Schema } from 'effect';
import { YouTubeDownloadId } from './ids';

/**
 * `queued` waits for the downloader, which saves one video at a time. `indexing` means the file is
 * saved and a scan is adding it to the YouTube library. Mirrored by `youtube_downloads.state`.
 */
export const YouTubeDownloadState = Schema.Literals(['queued', 'downloading', 'indexing', 'completed', 'failed']);
export type YouTubeDownloadState = typeof YouTubeDownloadState.Type;

/** `POST /api/youtube/downloads` body: a link to one YouTube video. */
export const StartYouTubeDownloadRequest = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)),
});
export interface StartYouTubeDownloadRequest extends Schema.Schema.Type<typeof StartYouTubeDownloadRequest> {}

/** `202` response of `POST /api/youtube/downloads`. Progress is synchronized by Zero. */
export const StartYouTubeDownloadResponse = Schema.Struct({ downloadId: YouTubeDownloadId });
export interface StartYouTubeDownloadResponse extends Schema.Schema.Type<typeof StartYouTubeDownloadResponse> {}
