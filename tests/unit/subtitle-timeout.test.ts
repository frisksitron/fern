import { describe, expect, it } from '@effect/vitest';
import { Duration } from 'effect';
import { subtitleExtractionTimeout } from '../../src/lib/server/playback/service';

describe('subtitleExtractionTimeout', () => {
  it('gives small files a minute and big files the time to read them at 25 MB/s', () => {
    const seconds = (bytes: number) => Duration.toSeconds(subtitleExtractionTimeout(bytes));
    expect(seconds(0)).toBe(60);
    expect(seconds(500 * 1024 ** 2)).toBe(80);
    // A 40 GB remux is read in about 27 minutes.
    expect(seconds(40 * 1024 ** 3)).toBe(60 + Math.ceil((40 * 1024) / 25));
  });
});
