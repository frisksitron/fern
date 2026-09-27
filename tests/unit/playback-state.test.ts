import { describe, expect, it } from 'vitest';
import { hasResumableProgress, isWatched, RESUME_MIN_MS } from '../../src/lib/shared/playback-state';

describe('playback state', () => {
  it('resumes unwatched progress from one second on', () => {
    expect(RESUME_MIN_MS).toBe(1_000);
    expect(hasResumableProgress({ positionMs: 1_000, watched: false })).toBe(true);
    expect(hasResumableProgress({ positionMs: 999, watched: false })).toBe(false);
    expect(hasResumableProgress({ positionMs: 500_000, watched: true })).toBe(false);
    expect(hasResumableProgress({ positionMs: 5_000, watched: null })).toBe(true);
    expect(hasResumableProgress(null)).toBe(false);
    expect(hasResumableProgress(undefined)).toBe(false);
  });

  it('marks ratio and long-content end margin watched', () => {
    expect(isWatched(900_000, 1_000_000)).toBe(true);
    expect(isWatched(881_000, 1_000_000)).toBe(true);
    expect(isWatched(80_000, 100_000)).toBe(false);
    expect(isWatched(1_000, null)).toBe(false);
    expect(isWatched(1_000, 0)).toBe(false);
  });

  it('applies the end margin only to media at least twice as long as the margin', () => {
    expect(isWatched(120_000, 240_000)).toBe(true);
    expect(isWatched(119_999, 239_999)).toBe(false);
  });
});
