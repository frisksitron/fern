import { describe, expect, it } from 'vitest';
import { isContained, normalizeRelative } from '../../src/lib/server/media/paths';

describe('path security', () => {
  it('rejects traversal, absolute paths and prefix collisions', () => {
    expect(() => normalizeRelative('../secret')).toThrow();
    expect(() => normalizeRelative('/secret')).toThrow();
    expect(() => normalizeRelative('C:\\secret')).toThrow();
    expect(() => normalizeRelative('a/../../secret')).toThrow();
    expect(normalizeRelative('a\\b/./c//d')).toBe('a/b/c/d');
    expect(isContained('/media/foo', '/media/foobar')).toBe(false);
    expect(isContained('/media/foo', '/media/foo/a')).toBe(true);
  });
});
