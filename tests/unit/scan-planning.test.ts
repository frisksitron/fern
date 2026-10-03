import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { Disk } from '../../src/lib/server/platform/disk';
import {
  artworkRank,
  planEntries,
  planSubtitleRemovals,
  planSubtitles,
  PROBE_VERSION,
  type ExistingEntry,
} from '../../src/lib/server/scans/plan';
import { canTransition, isTerminalScanState, statesBefore } from '../../src/lib/server/scans/state';
import { traverseRoot, type DiscoveredItem } from '../../src/lib/server/scans/traversal';
import { fakeDisk } from '../support/fakes';

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

  it('keeps entries at or under unreadable paths and removes the rest', () => {
    const plan = planEntries(
      'video',
      items,
      [
        ...items.map((item) => stored(item)),
        stored(file('Locked/inside.mp4')),
        stored(file('Locked/deeper/inside.mp4')),
        stored(file('Lockedness/other.mp4')),
        stored(file('Movies/unstatable.mp4')),
        stored(file('Movies/old.mp4')),
      ],
      ['Locked', 'Movies/unstatable.mp4'],
    );
    // 'Lockedness' only shares a name prefix with the unreadable 'Locked'.
    expect(plan.removedIds).toEqual(['id:Lockedness/other.mp4', 'id:Movies/old.mp4']);
  });

  it('treats audio as media only in music roots', () => {
    const song = [file('Album/song.flac')];
    expect(planEntries('music', song, []).entries[0]).toMatchObject({ isAudio: true, probeStatus: 'pending' });
    expect(planEntries('video', song, []).entries[0]).toMatchObject({ isAudio: false, probeStatus: 'not_required' });
  });
});

describe('planSubtitles', () => {
  const pairs = (items: readonly DiscoveredItem[]) =>
    planSubtitles(planEntries('video', items, []).entries).map((subtitle) => [subtitle.relativePath, subtitle.format]);

  it('pairs subtitles with the video of the same name, in the same folder', () => {
    expect(
      pairs([
        directory('A'),
        file('A/Movie.mp4'),
        file('A/Movie.en.srt'),
        file('A/Movie.en.forced.vtt'),
        file('A/Other.vtt'),
        directory('B'),
        file('B/Movie.srt'),
      ]),
    ).toEqual([
      ['A/Movie.en.srt', 'srt'],
      ['A/Movie.en.forced.vtt', 'vtt'],
    ]);
  });

  it('does not attach a subtitle to a video whose name is only a prefix of its own', () => {
    const entries = planEntries(
      'video',
      [
        file('Lecture 1.mkv'),
        file('Lecture 10.mkv'),
        file('Lecture 10.en.srt'),
        file('Lecture 1.en.srt'),
        file('Lecture 100.srt'),
      ],
      [],
    ).entries;
    const idOf = (name: string) => entries.find((entry) => entry.name === name)!.id;
    expect(planSubtitles(entries).map((subtitle) => [subtitle.relativePath, subtitle.mediaEntryId])).toEqual([
      ['Lecture 10.en.srt', idOf('Lecture 10.mkv')],
      ['Lecture 1.en.srt', idOf('Lecture 1.mkv')],
    ]);
  });

  it('prefers the video with the longest matching name', () => {
    const entries = planEntries(
      'video',
      [file('Show.mkv'), file('Show.Extended.mkv'), file('Show.Extended.en.srt')],
      [],
    ).entries;
    expect(planSubtitles(entries).map((subtitle) => subtitle.mediaEntryId)).toEqual([
      entries.find((entry) => entry.name === 'Show.Extended.mkv')!.id,
    ]);
  });

  it('keeps videos with the same name in different folders apart', () => {
    const entries = planEntries(
      'video',
      [directory('A'), directory('B'), file('A/Movie.mkv'), file('B/Movie.mkv'), file('B/Movie.srt')],
      [],
    ).entries;
    const [subtitle] = planSubtitles(entries);
    expect(subtitle.mediaEntryId).toBe(entries.find((entry) => entry.relativePath === 'B/Movie.mkv')!.id);
  });

  it('handles a large library in one pass', () => {
    const items = Array.from({ length: 5000 }, (_, index) => [
      file(`Show/Episode ${index}.mkv`),
      file(`Show/Episode ${index}.en.srt`),
    ]).flat();
    const entries = planEntries('video', [directory('Show'), ...items], []).entries;
    expect(planSubtitles(entries)).toHaveLength(5000);
  });
});

describe('planSubtitleRemovals', () => {
  const association = (mediaEntryId: string, relativePath: string) => ({
    mediaEntryId,
    relativePath,
    name: relativePath,
    format: 'srt',
    mtimeMs: 1,
  });

  it('removes subtitles that are no longer paired with the same video, except under unreadable paths', () => {
    const existing = [
      { id: 'kept', mediaEntryId: 'v1', relativePath: 'A/a.srt' },
      { id: 'gone', mediaEntryId: 'v1', relativePath: 'A/gone.srt' },
      { id: 'moved', mediaEntryId: 'v2', relativePath: 'A/a.srt' },
      { id: 'locked', mediaEntryId: 'v3', relativePath: 'Locked/b.srt' },
    ];
    expect(planSubtitleRemovals(existing, [association('v1', 'A/a.srt')], ['Locked'])).toEqual(['gone', 'moved']);
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
  const disk = fakeDisk(
    {
      '/root/B/two.mp4': { size: 2, mtimeMs: 2.6 },
      '/root/A/one.mp4': { size: 1, mtimeMs: 1.2 },
      '/root/A/.DS_Store': { size: 1 },
      '/root/A/._one.mp4': { size: 1 },
      '/root/.stfolder/marker': { size: 1 },
      '/root/link': { link: '/root/A' },
      '/root/Locked/secret.mp4': { size: 1 },
      '/root/lost+found/orphan': { size: 1 },
      '/root/A/@eaDir/one.mp4/thumb': { size: 1 },
      '/root/$RECYCLE.BIN/old.mp4': { size: 1 },
      '/root/System Volume Information/tracking.log': { size: 1 },
      '/root/B/unreadable.mp4': { size: 1 },
    },
    { denied: ['/root/Locked', '/root/B/unreadable.mp4'], vanished: ['/root/B/vanished.mp4'] },
  );
  const traverse = (root: string) => Disk.Service.use((fake) => traverseRoot(fake, root)).pipe(Effect.provide(disk));

  it.effect(
    'lists directories before their contents, skipping links, hidden and system folders, and vanished files',
    () =>
      Effect.gen(function* () {
        const result = yield* traverse('/root');
        expect(result.items.map((item) => [item.relativePath, item.parentPath, item.mtimeMs])).toEqual([
          ['A', null, 0],
          ['B', null, 0],
          ['A/one.mp4', 'A', 1],
          ['B/two.mp4', 'B', 3],
        ]);
        // A file that vanished between listing and stat is gone, not a warning.
        expect(result.warnings.map((warning) => [warning.relativePath, warning.cause._tag])).toEqual([
          ['Locked', 'PathAccessDenied'],
          ['B/unreadable.mp4', 'PathAccessDenied'],
        ]);
      }),
  );

  it.effect('fails when the root itself is missing', () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(traverse('/missing'))).toMatchObject({ _tag: 'RootUnavailable' });
    }),
  );
});
