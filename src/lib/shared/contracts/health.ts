import { Schema } from 'effect';

const CheckStatus = Schema.Literals(['ok', 'unavailable']);

/** `GET /health/ready`: 200 when every check passes, otherwise 503. */
export const ReadinessResponse = Schema.Struct({
  status: Schema.Literals(['ready', 'unavailable']),
  checks: Schema.Struct({
    database: CheckStatus,
    ffmpeg: CheckStatus,
    ffprobe: CheckStatus,
    /** The cache and downloads folders, each of which must be writable by the server's user. */
    hlsCache: CheckStatus,
    thumbnailCache: CheckStatus,
    trackMapCache: CheckStatus,
    downloads: CheckStatus,
  }),
});
export interface ReadinessResponse extends Schema.Schema.Type<typeof ReadinessResponse> {}
