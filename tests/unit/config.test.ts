import path from 'node:path';
import { Redacted } from 'effect';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/server/config';

describe('loadConfig', () => {
  it('applies defaults when settings are absent or empty', () => {
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
    const { DATABASE_URL, ...rest } = loadConfig(empty);
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
  });

  it('parses numbers, literals, and browse roots from environment strings', () => {
    const config = loadConfig({
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
  });

  it('keeps the database URL, which holds the password, out of logs', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://fern:secret@db/fern' });
    expect(String(config.DATABASE_URL)).not.toContain('secret');
    expect(JSON.stringify(config)).not.toContain('secret');
  });

  it('rejects invalid settings with an error naming the setting', () => {
    expect(() => loadConfig({ MAX_CONCURRENT_TRANSCODES: '0' })).toThrow(
      /Invalid Fern configuration.*MAX_CONCURRENT_TRANSCODES/s,
    );
    expect(() => loadConfig({ TRANSCODE_THREADS: '1.5' })).toThrow(/TRANSCODE_THREADS/);
    expect(() => loadConfig({ HLS_CACHE_MAX_BYTES: 'lots' })).toThrow(/HLS_CACHE_MAX_BYTES/);
    expect(() => loadConfig({ TRANSCODE_ACCELERATOR: 'gpu' })).toThrow(/TRANSCODE_ACCELERATOR/);
    expect(() => loadConfig({ LOG_FORMAT: 'xml' })).toThrow(/LOG_FORMAT/);
  });
});
