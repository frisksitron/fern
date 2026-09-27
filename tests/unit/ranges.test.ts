import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../../src/lib/server/media/ranges';

describe('parseByteRange', () => {
  it('parses bounded, open-ended, and suffix ranges', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-10', 1000)).toEqual({ start: 990, end: 999 });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('clamps the end to the file size', () => {
    expect(parseByteRange('bytes=500-5000', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('rejects malformed and unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBeNull();
    expect(parseByteRange('bytes=10-5', 1000)).toBeNull();
    expect(parseByteRange('items=0-1', 1000)).toBeNull();
    expect(parseByteRange('bytes=0-1,5-6', 1000)).toBeNull();
  });
});
