import path from 'node:path';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Redacted } from 'effect';
import { FernConfig } from '../../src/lib/server/config';

/** The settings decoded from environment-style values. */
const settings = (values: Record<string, string>) => Effect.provide(FernConfig.Service, FernConfig.layerFrom(values));

describe('FernConfig', () => {
  it.effect('applies defaults when settings are absent or empty', () =>
    Effect.gen(function* () {
      // docker-compose.yml passes every tuning setting through, empty when .env leaves it unset.
      const empty = Object.fromEntries(
        [
          'HLS_CACHE_MAX_BYTES',
          'HLS_CACHE_MAX_AGE_HOURS',
          'THUMBNAIL_CACHE_MAX_BYTES',
          'THUMBNAIL_CACHE_MAX_AGE_HOURS',
          'TRACK_MAP_CACHE_MAX_BYTES',
          'TRACK_MAP_CACHE_MAX_AGE_HOURS',
          'MAX_CONCURRENT_TRANSCODES',
          'TRANSCODE_MAX_WAITING',
          'TRANSCODE_THREADS',
          'TRANSCODE_ACCELERATOR',
          'SCAN_PROBE_CONCURRENCY',
          'LOG_LEVEL',
          'BROWSE_ROOTS',
        ].map((name) => [name, '']),
      );
      const { DATABASE_URL, ...rest } = yield* settings(empty);
      expect(Redacted.value(DATABASE_URL)).toBe('postgres://fern:fern@localhost:5432/fern');
      expect(rest).toEqual({
        HLS_CACHE_DIR: './.cache/hls',
        HLS_CACHE_MAX_BYTES: 50 * 1024 ** 3,
        HLS_CACHE_MAX_AGE_HOURS: 72,
        THUMBNAIL_CACHE_DIR: './.cache/thumbnails',
        THUMBNAIL_CACHE_MAX_BYTES: 1024 ** 3,
        THUMBNAIL_CACHE_MAX_AGE_HOURS: 168,
        TRACK_MAP_CACHE_DIR: './.cache/track-maps',
        TRACK_MAP_CACHE_MAX_BYTES: 256 * 1024 ** 2,
        TRACK_MAP_CACHE_MAX_AGE_HOURS: 2160,
        MAX_CONCURRENT_TRANSCODES: 2,
        TRANSCODE_MAX_WAITING: 8,
        TRANSCODE_THREADS: 2,
        TRANSCODE_ACCELERATOR: 'auto',
        SCAN_PROBE_CONCURRENCY: 4,
        FFMPEG_PATH: 'ffmpeg',
        FFPROBE_PATH: 'ffprobe',
        YTDLP_PATH: 'yt-dlp',
        DOWNLOADS_DIR: './downloads',
        LOG_LEVEL: 'Info',
        LOG_FORMAT: 'pretty',
        BROWSE_ROOTS: [],
      });
    }),
  );

  it.effect('parses numbers, literals, and browse roots from environment strings', () =>
    Effect.gen(function* () {
      const config = yield* settings({
        HLS_CACHE_MAX_AGE_HOURS: '1.5',
        MAX_CONCURRENT_TRANSCODES: '4',
        TRANSCODE_ACCELERATOR: 'qsv',
        BROWSE_ROOTS: ['/media', '/mnt/nas'].join(path.delimiter),
      });
      expect(config).toMatchObject({
        HLS_CACHE_MAX_AGE_HOURS: 1.5,
        MAX_CONCURRENT_TRANSCODES: 4,
        TRANSCODE_ACCELERATOR: 'qsv',
        BROWSE_ROOTS: ['/media', '/mnt/nas'],
      });
    }),
  );

  it.effect('keeps the database URL, which holds the password, out of logs', () =>
    Effect.gen(function* () {
      const config = yield* settings({ DATABASE_URL: 'postgres://fern:secret@db/fern' });
      expect(String(config.DATABASE_URL)).not.toContain('secret');
      expect(JSON.stringify(config)).not.toContain('secret');
    }),
  );

  it.effect('rejects invalid settings with an error naming the setting', () =>
    Effect.gen(function* () {
      const invalid: Array<[string, string]> = [
        ['MAX_CONCURRENT_TRANSCODES', '0'],
        ['TRANSCODE_THREADS', '1.5'],
        ['HLS_CACHE_MAX_BYTES', 'lots'],
        ['TRANSCODE_ACCELERATOR', 'gpu'],
        ['LOG_FORMAT', 'xml'],
      ];
      for (const [name, value] of invalid) {
        const error = yield* Effect.flip(settings({ [name]: value }));
        expect(error.message).toContain(name);
      }
    }),
  );
});
