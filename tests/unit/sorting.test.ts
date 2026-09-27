import { expect, it } from 'vitest';
import { findUpNext, sortEntries } from '../../src/lib/shared/sorting';

it('sorts folders first then names naturally', () => {
  const rows = [
    { id: '4', name: '10.mkv', kind: 'file' as const },
    { id: '2', name: '2.mkv', kind: 'file' as const },
    { id: '1', name: 'Zoo', kind: 'directory' as const },
    { id: '3', name: '1.mkv', kind: 'file' as const },
  ];
  expect(sortEntries(rows).map((entry) => entry.name)).toEqual(['Zoo', '1.mkv', '2.mkv', '10.mkv']);
});

it('uses a folder’s manual media order before filename order', () => {
  const rows = [
    { id: '1', name: 'Episode A.mkv', kind: 'file', sortOrder: 1 },
    { id: '2', name: 'Episode B.mkv', kind: 'file', sortOrder: 0 },
    { id: '3', name: 'Episode C.mkv', kind: 'file' },
  ];
  expect(sortEntries(rows).map((entry) => entry.id)).toEqual(['2', '1', '3']);
});

it('suggests the next unwatched sibling using natural filename order', () => {
  const entries = ['S01E01.mkv', 'S01E02.mkv', 'S01E10.mkv'].map((name, index) => ({
    id: String(index + 1),
    name,
    kind: 'file',
    mediaRootId: 'root',
    parentId: 'season',
    isVideo: true,
  }));
  const progress = [
    { mediaEntryId: '1', watched: true, lastPlayedAt: 1 },
    { mediaEntryId: '2', watched: true, lastPlayedAt: 2 },
  ];
  expect(findUpNext(entries, progress, new Set(), 30).map((entry) => entry.name)).toEqual(['S01E10.mkv']);
});

it('suggests the next unwatched sibling using the manual folder order', () => {
  const entries = ['Special.mkv', 'Episode 1.mkv', 'Episode 2.mkv'].map((name, index) => ({
    id: String(index + 1),
    name,
    kind: 'file',
    sortOrder: [1, 0, 2][index],
    mediaRootId: 'root',
    parentId: 'season',
    isVideo: true,
  }));
  expect(findUpNext(entries, [{ mediaEntryId: '2', watched: true }], new Set(), 30).map((entry) => entry.name)).toEqual(
    ['Special.mkv'],
  );
});

it('does not duplicate media that is already in Continue Watching', () => {
  const entries = ['S01E01.mkv', 'S01E02.mkv'].map((name, index) => ({
    id: String(index + 1),
    name,
    kind: 'file',
    mediaRootId: 'root',
    parentId: 'season',
    isVideo: true,
  }));
  expect(findUpNext(entries, [{ mediaEntryId: '1', watched: true }], new Set(['2']), 30)).toEqual([]);
});

it('does not suggest another episode while the same season is in progress', () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    id: String(index + 1),
    name: `S01E0${index + 1}.mkv`,
    kind: 'file',
    mediaRootId: 'root',
    parentId: 'season',
    isVideo: true,
  }));
  const progress = [
    { mediaEntryId: '1', watched: false, lastPlayedAt: 5 },
    { mediaEntryId: '2', watched: true, lastPlayedAt: 2 },
    { mediaEntryId: '3', watched: true, lastPlayedAt: 3 },
    { mediaEntryId: '4', watched: true, lastPlayedAt: 4 },
  ];
  expect(findUpNext(entries, progress, new Set(['1']), 30)).toEqual([]);
});
