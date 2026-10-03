import { Config, ConfigProvider, Context, Effect, Layer, Redacted, Schema } from 'effect';
import { env } from '$env/dynamic/private';
import { parseBrowseRoots } from './media/paths';

const text = (name: string, fallback: string) => Config.String(name).pipe(Config.withDefault(fallback));

const positive = (name: string, fallback: number) =>
  Config.schema(Schema.Finite.check(Schema.isGreaterThan(0)), name).pipe(Config.withDefault(fallback));

const positiveInt = (name: string, fallback: number) =>
  Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), name).pipe(Config.withDefault(fallback));

/** Every server setting, read from the environment. Empty values count as unset. */
export const AppConfig = Config.all({
  // Redacted: the URL carries the database password, so it never appears in logs.
  DATABASE_URL: Config.Redacted('DATABASE_URL').pipe(
    Config.withDefault(Redacted.make('postgres://fern:fern@localhost:5432/fern')),
  ),
  HLS_CACHE_DIR: text('HLS_CACHE_DIR', './.cache/hls'),
  HLS_CACHE_MAX_BYTES: positive('HLS_CACHE_MAX_BYTES', 50 * 1024 ** 3),
  HLS_CACHE_MAX_AGE_HOURS: positive('HLS_CACHE_MAX_AGE_HOURS', 72),
  THUMBNAIL_CACHE_DIR: text('THUMBNAIL_CACHE_DIR', './.cache/thumbnails'),
  THUMBNAIL_CACHE_MAX_BYTES: positive('THUMBNAIL_CACHE_MAX_BYTES', 1024 ** 3),
  THUMBNAIL_CACHE_MAX_AGE_HOURS: positive('THUMBNAIL_CACHE_MAX_AGE_HOURS', 168),
  // Songs analysed for the music visual effects.
  TRACK_MAP_CACHE_DIR: text('TRACK_MAP_CACHE_DIR', './.cache/track-maps'),
  TRACK_MAP_CACHE_MAX_BYTES: positive('TRACK_MAP_CACHE_MAX_BYTES', 256 * 1024 ** 2),
  TRACK_MAP_CACHE_MAX_AGE_HOURS: positive('TRACK_MAP_CACHE_MAX_AGE_HOURS', 2160),
  MAX_CONCURRENT_TRANSCODES: positiveInt('MAX_CONCURRENT_TRANSCODES', 2),
  // Segment requests that may wait for a transcode slot; more are answered 503 with Retry-After.
  TRANSCODE_MAX_WAITING: positiveInt('TRANSCODE_MAX_WAITING', 8),
  TRANSCODE_THREADS: positiveInt('TRANSCODE_THREADS', 2),
  TRANSCODE_ACCELERATOR: Config.Literals(['auto', 'nvenc', 'qsv', 'software'], 'TRANSCODE_ACCELERATOR').pipe(
    Config.withDefault('auto'),
  ),
  // ffprobe processes a scan runs at once.
  SCAN_PROBE_CONCURRENCY: positiveInt('SCAN_PROBE_CONCURRENCY', 4),
  FFMPEG_PATH: text('FFMPEG_PATH', 'ffmpeg'),
  FFPROBE_PATH: text('FFPROBE_PATH', 'ffprobe'),
  YTDLP_PATH: text('YTDLP_PATH', 'yt-dlp'),
  // Where songs from YouTube are saved. Fern keeps it as a music library of its own, separate from
  // the media folders users add, so nothing is ever written into those.
  DOWNLOADS_DIR: text('DOWNLOADS_DIR', './downloads'),
  // Log entries below this level are dropped.
  LOG_LEVEL: Config.Literals(['Trace', 'Debug', 'Info', 'Warn', 'Error'], 'LOG_LEVEL').pipe(Config.withDefault('Info')),
  // `json` writes one JSON object per entry with its fields (scanId, requestId, …); `pretty` is for terminals.
  LOG_FORMAT: Config.Literals(['pretty', 'json'], 'LOG_FORMAT').pipe(Config.withDefault('pretty')),
  // Directories the media-folder picker may show and media roots must live under. Empty means unrestricted.
  BROWSE_ROOTS: Config.String('BROWSE_ROOTS').pipe(
    Config.withDefault(''),
    Config.map((value) => parseBrowseRoots(value)),
  ),
});

export type AppConfig = Config.Success<typeof AppConfig>;

/** The configuration decoded at startup, for Effect services. */
export class FernConfig extends Context.Service<FernConfig, AppConfig>()('fern/Config') {}

/** Parses environment-style values. Invalid settings throw an error naming the setting. */
export function loadConfig(values: Readonly<Record<string, string | undefined>>): AppConfig {
  try {
    return Effect.runSync(AppConfig.parse(ConfigProvider.fromUnknown(values)));
  } catch (cause) {
    throw new Error(`Invalid Fern configuration: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

/**
 * The configuration from the server environment. Building the application runtime decodes it, so
 * invalid configuration stops startup with an error naming the setting.
 */
export const FernConfigLive = Layer.effect(
  FernConfig,
  Effect.sync(() => loadConfig(env)),
);
