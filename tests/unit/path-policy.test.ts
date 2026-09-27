import { describe, expect, it } from 'vitest';
import { comparablePath, isSameOrInside, parseBrowseRoots, pathsOverlap } from '../../src/lib/server/media/paths';

describe('comparablePath', () => {
  it('normalizes separators and trailing slashes', () => {
    expect(comparablePath('/media/anime/')).toBe('/media/anime');
    expect(comparablePath('/')).toBe('/');
    expect(comparablePath('C:\\Media\\Anime\\')).toBe('c:/media/anime');
    expect(comparablePath('\\\\NAS\\Media')).toBe('//nas/media');
  });

  it('keeps POSIX paths case-sensitive', () => {
    expect(comparablePath('/Media')).not.toBe(comparablePath('/media'));
  });
});

describe('pathsOverlap', () => {
  it('detects equal, parent, and child paths', () => {
    expect(pathsOverlap('/media', '/media/')).toBe(true);
    expect(pathsOverlap('/media', '/media/anime')).toBe(true);
    expect(pathsOverlap('/media/anime', '/media')).toBe(true);
    expect(pathsOverlap('/', '/anything')).toBe(true);
  });

  it('does not treat shared name prefixes as overlap', () => {
    expect(pathsOverlap('/media/foo', '/media/foobar')).toBe(false);
    expect(pathsOverlap('/media/anime', '/media/movies')).toBe(false);
  });

  it('compares Windows drive and UNC paths case-insensitively across separator styles', () => {
    expect(pathsOverlap('C:\\Media', 'c:/media/Anime')).toBe(true);
    expect(pathsOverlap('C:\\', 'C:\\Media')).toBe(true);
    expect(pathsOverlap('\\\\NAS\\Media\\anime', '//nas/media/ANIME/Frieren')).toBe(true);
    expect(pathsOverlap('\\\\nas\\Media\\anime', '\\\\nas\\Media\\music')).toBe(false);
  });
});

describe('isSameOrInside', () => {
  it('is directional', () => {
    expect(isSameOrInside('/media', '/media/anime')).toBe(true);
    expect(isSameOrInside('/media/anime', '/media')).toBe(false);
  });
});

describe('parseBrowseRoots', () => {
  it('splits on the given delimiter and ignores blanks', () => {
    expect(parseBrowseRoots(undefined)).toEqual([]);
    expect(parseBrowseRoots('  ')).toEqual([]);
    expect(parseBrowseRoots('/media: /mnt/nas :', ':')).toEqual(['/media', '/mnt/nas']);
    expect(parseBrowseRoots('D:\\Media;\\\\nas\\share', ';')).toEqual(['D:\\Media', '\\\\nas\\share']);
  });
});
