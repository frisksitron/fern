import { describe, expect, it } from 'vitest';
import {
  chapterIndexAt,
  formatClock,
  nextChapterStart,
  previousChapterStart,
  type Chapter,
} from '../../src/lib/music/chapters';

const mix: Chapter[] = [
  { startMs: 0, endMs: 198_000, title: 'overtime' },
  { startMs: 198_000, endMs: 503_000, title: 'everyone already left' },
  { startMs: 503_000, endMs: 728_000, title: 'i’ll finish this first' },
];

describe('chapters', () => {
  it('finds the playing chapter', () => {
    expect(chapterIndexAt(mix, 0)).toBe(0);
    expect(chapterIndexAt(mix, 197_999)).toBe(0);
    expect(chapterIndexAt(mix, 198_000)).toBe(1);
    expect(chapterIndexAt(mix, 900_000)).toBe(2);
    expect(chapterIndexAt([], 1000)).toBe(-1);
    expect(chapterIndexAt([{ startMs: 5000, endMs: 9000, title: null }], 1000)).toBe(-1);
  });

  it('goes to the next chapter, and to the next song from the last one', () => {
    expect(nextChapterStart(mix, 10_000)).toBe(198_000);
    expect(nextChapterStart(mix, 200_000)).toBe(503_000);
    expect(nextChapterStart(mix, 600_000)).toBeNull();
    expect(nextChapterStart([], 0)).toBeNull();
  });

  it('goes back to the chapter’s start, or to the one before when it has just started', () => {
    expect(previousChapterStart(mix, 300_000)).toBe(198_000);
    expect(previousChapterStart(mix, 199_000)).toBe(0);
    expect(previousChapterStart(mix, 60_000)).toBe(0);
    // The first chapter's opening seconds: the previous song plays instead.
    expect(previousChapterStart(mix, 2000)).toBeNull();
    expect(previousChapterStart([], 60_000)).toBeNull();
  });

  it('formats positions with hours once a mix is that long', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(59.9)).toBe('0:59');
    expect(formatClock(198)).toBe('3:18');
    expect(formatClock(3644)).toBe('1:00:44');
    expect(formatClock(6976.14)).toBe('1:56:16');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});
