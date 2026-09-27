import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  artworkRank,
  planEntries,
  planSubtitles,
  PROBE_VERSION,
  type ExistingEntry,
} from '../../src/lib/server/scans/plan';
import { canTransition, isTerminalScanState, statesBefore } from '../../src/lib/server/scans/state';
import { traverseRoot, type DiscoveredItem } from '../../src/lib/server/scans/traversal';
import { fakeFileSystem } from '../support/fakes';

const file = (relativePath: string, sizeBytes = 10, mtimeMs = 1000): DiscoveredItem => {
  const name = relativePath.split('/').at(-1)!;
  const parent = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : null;
  return {
    relativePath,
    parentPath: parent,
    name,
    kind: 'file',
    extension: name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '',
    sizeBytes,
    mtimeMs,
  };
};
const directory = (relativePath: string): DiscoveredItem => ({
  ...file(relativePath),
  kind: 'directory',
  extension: null,
  sizeBytes: null,
});

function stored(item: DiscoveredItem, overrides: Partial<ExistingEntry> = {}): ExistingEntry {
  return {
    id: `id:${item.relativePath}`,
    relativePath: item.relativePath,
    parentId: item.parentPath ? `id:${item.parentPath}` : null,
    name: item.name,
    kind: item.kind,
    extension: item.extension,
    sizeBytes: item.sizeBytes,
    mtimeMs: item.mtimeMs,
    isVideo: item.extension === '.mp4',
    isAudio: false,
    probeStatus: item.extension === '.mp4' ? 'ok' : 'not_required',
    probeVersion: PROBE_VERSION,
    deletedAt: null,
    artworkMediaEntryId: null,
    ...overrides,
  };
}

describe('scan states', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('failed', 'completed')).toBe(false);
    expect(statesBefore('failed').sort()).toEqual(['queued', 'retrying', 'running']);
    expect(canTransition('running', 'retrying')).toBe(true);
    expect(canTransition('retrying', 'running')).toBe(true);
    // A graceful shutdown hands a running scan back to the queue.
    expect(canTransition('running', 'queued')).toBe(true);
    expect(isTerminalScanState('completed')).toBe(true);
    expect(isTerminalScanState('queued')).toBe(false);
  });
});

describe('planEntries', () => {
  const items = [directory('Movies'), file('Movies/a.mp4'), file('Movies/notes.txt')];

  it('keeps stored IDs, links parents, and marks new media for probing', () => {
    const plan = planEntries('video', items, []);
    expect(plan.entries.map((entry) => [entry.relativePath, entry.probeStatus, entry.changed])).toEqual([
      ['Movies', 'not_required', true],
      ['Movies/a.mp4', 'pending', true],
      ['Movies/notes.txt', 'not_required', true],
    ]);
    expect(plan.entries[1].parentId).toBe(plan.entries[0].id);
  });

  it('writes and probes nothing for unchanged entries', () => {
    const plan = planEntries(
      'video',
      items,
      items.map((item) => stored(item)),
    );
    expect(plan.entries.every((entry) => !entry.changed)).toBe(true);
    expect(plan.entries.map((entry) => entry.id)).toEqual(items.map((item) => `id:${item.relativePath}`));
    expect(plan.removedIds).toEqual([]);
  });

  it('re-probes changed, failed, and outdated media', () => {
    const [folder, video, notes] = items;
    const cases: Array<[Partial<ExistingEntry>, string]> = [
      [{ sizeBytes: 9 }, 'size changed'],
      [{ mtimeMs: 999 }, 'mtime changed'],
      [{ probeStatus: 'failed' }, 'previous probe failed'],
      [{ probeVersion: PROBE_VERSION - 1 }, 'older probe version'],
    ];
    for (const [change, reason] of cases) {
      const plan = planEntries('video', items, [stored(folder), stored(video, change), stored(notes)]);
      expect(plan.entries[1], reason).toMatchObject({ probeStatus: 'pending', changed: true });
    }
  });

  it('restores deleted entries and removes entries that are gone', () => {
    const plan = planEntries('video', items, [
      ...items.map((item) => stored(item, item.relativePath === 'Movies' ? { deletedAt: new Date() } : {})),
      stored(file('Movies/old.mp4')),
      stored(file('Movies/already-gone.mp4'), { deletedAt: new Date() }),
    ]);
    expect(plan.entries[0].changed).toBe(true);
    expect(plan.removedIds).toEqual(['id:Movies/old.mp4']);
  });

  it('treats audio as media only in music roots', () => {
    const song = [file('Album/song.flac')];
    expect(planEntries('music', song, []).entries[0]).toMatchObject({ isAudio: true, probeStatus: 'pending' });
    expect(planEntries('video', song, []).entries[0]).toMatchObject({ isAudio: false, probeStatus: 'not_required' });
  });
});

describe('planSubtitles', () => {
  it('pairs subtitles with the video whose name they start with, in the same folder', () => {
    const plan = planEntries(
      'video',
      [
        directory('A'),
        file('A/Movie.mp4'),
        file('A/Movie.en.srt'),
        file('A/Other.vtt'),
        directory('B'),
        file('B/Movie.srt'),
      ],
      [],
    );
    expect(planSubtitles(plan.entries).map((subtitle) => [subtitle.relativePath, subtitle.format])).toEqual([
      ['A/Movie.en.srt', 'srt'],
    ]);
  });
});

describe('artworkRank', () => {
  it('prefers cover art names', () => {
    const names = [
      'random.jpg',
      'folder.jpg',
      'AlbumArt_Large.jpg',
      'front.png',
      'cover.jpg',
      'cover-back.jpg',
      'AlbumArtSmall.jpg',
    ];
    expect([...names].sort((left, right) => artworkRank(left) - artworkRank(right))).toEqual([
      'cover.jpg',
      'cover-back.jpg',
      'front.png',
      'folder.jpg',
      'AlbumArt_Large.jpg',
      'AlbumArtSmall.jpg',
      'random.jpg',
    ]);
  });
});

describe('traverseRoot', () => {
  const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.result(effect));
  const layer = fakeFileSystem(
    {
      '/root/B/two.mp4': { size: 2, mtimeMs: 2.6 },
      '/root/A/one.mp4': { size: 1, mtimeMs: 1.2 },
      '/root/A/.DS_Store': { size: 1 },
      '/root/A/._one.mp4': { size: 1 },
      '/root/.stfolder/marker': { size: 1 },
      '/root/link': { link: '/root/A' },
      '/root/Locked/secret.mp4': { size: 1 },
    },
    { denied: ['/root/Locked'] },
  );
  const traverse = (root: string) => run(Effect.provide(traverseRoot(root), layer));

  it('lists directories before their contents, skipping links and hidden files and folders', async () => {
    const result = await traverse('/root');
    expect(result._tag).toBe('Success');
    if (result._tag !== 'Success') return;
    expect(result.success.items.map((item) => [item.relativePath, item.parentPath, item.mtimeMs])).toEqual([
      ['A', null, 0],
      ['B', null, 0],
      ['A/one.mp4', 'A', 1],
      ['B/two.mp4', 'B', 3],
    ]);
    expect(result.success.warnings.map((warning) => [warning.relativePath, warning.cause._tag])).toEqual([
      ['Locked', 'PathAccessDenied'],
    ]);
  });

  it('fails when the root itself is missing', async () => {
    expect(await traverse('/missing')).toMatchObject({ _tag: 'Failure', failure: { _tag: 'RootUnavailable' } });
  });
});
