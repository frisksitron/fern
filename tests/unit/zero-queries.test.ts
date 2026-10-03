import { mustGetQuery } from '@rocicorp/zero';
import { describe, expect, it } from 'vitest';
import { queries } from '../../src/lib/zero/queries';

const profileId = '10000000-0000-4000-8000-000000000001';
const rootId = '20000000-0000-4000-8000-000000000001';
const entryId = '30000000-0000-4000-8000-000000000001';
const playlistId = '40000000-0000-4000-8000-000000000001';

/** Arguments for each query; a new query fails this test until it is listed here. */
const sampleArgs: Record<string, unknown> = {
  'profiles.all': undefined,
  'mediaRoots.all': undefined,
  'mediaRoots.byType': { mediaType: 'video' },
  'mediaEntries.byIds': { ids: [entryId] },
  'mediaEntries.searchMusic': { text: 'blue' },
  'mediaEntries.children': { rootId, parentId: null },
  'mediaEntries.musicChildren': { rootId, parentId: entryId },
  'mediaEntries.byId': { id: entryId },
  'chapters.forMedia': { mediaEntryId: entryId },
  'youtubeDownloads.recent': undefined,
  'playlists.forProfile': { profileId },
  'playlistItems.forPlaylist': { playlistId },
  'progress.forMedia': { profileId, mediaEntryId: entryId },
  'progress.forMediaIds': { profileId, ids: [entryId] },
  'progress.recentlyWatched': { profileId },
  'progress.continueWatching': { profileId },
};

type Condition =
  | { type: 'simple'; op: string; left: { name: string }; right: unknown }
  | { type: 'and' | 'or'; conditions: Condition[] };
type Ast = { table: string; limit?: number; where?: Condition };

/** Columns whose equality (or IN over a bounded list) limits a query to one folder, playlist, or set of IDs. */
const scopingColumns = new Set(['id', 'parentId', 'playlistId', 'mediaEntryId']);
/** Tables that stay small however large the library grows. */
const smallTables = new Set(['profiles', 'mediaRoots', 'playlists']);

function scopedBy(condition: Condition | undefined): boolean {
  if (!condition) return false;
  // `parentId IS NULL` is a root folder.
  if (condition.type === 'simple')
    return scopingColumns.has(condition.left.name) && ['=', 'IN', 'IS'].includes(condition.op);
  if (condition.type === 'and') return condition.conditions.some(scopedBy);
  return condition.conditions.every(scopedBy);
}

function queryNames(tree: object, prefix = ''): string[] {
  // `~` holds Zero's own metadata, not queries.
  return Object.entries(tree).flatMap(([key, value]) =>
    key === '~'
      ? []
      : typeof value === 'object' && value !== null && !('fn' in value)
        ? queryNames(value, `${prefix}${key}.`)
        : [`${prefix}${key}`],
  );
}

describe('Zero queries', () => {
  const names = queryNames(queries);

  it('are all covered by this test', () => {
    expect(names.sort()).toEqual(Object.keys(sampleArgs).sort());
  });

  it.each(Object.keys(sampleArgs))('%s never synchronizes an unbounded part of the library', (name) => {
    const query = mustGetQuery(queries, name).fn({ args: sampleArgs[name] as never });
    const ast = (query as unknown as { ast: Ast }).ast;
    const bounded = ast.limit !== undefined || smallTables.has(ast.table) || scopedBy(ast.where);
    expect(bounded, JSON.stringify(ast)).toBe(true);
  });
});
