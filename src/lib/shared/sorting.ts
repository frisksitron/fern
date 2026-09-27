type SortableEntry = { id: string; name: string; kind: string; sortOrder?: number | null };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function sortEntries<T extends SortableEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    if (a.kind !== 'directory' && (a.sortOrder != null || b.sortOrder != null)) {
      if (a.sortOrder == null) return 1;
      if (b.sortOrder == null) return -1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    }
    return collator.compare(a.name, b.name) || a.id.localeCompare(b.id);
  });
}

export function findUpNext<
  T extends SortableEntry & { mediaRootId: string; parentId?: string | null; isVideo?: boolean | null },
>(
  allEntries: readonly T[],
  allProgress: Array<{ mediaEntryId: string; watched?: boolean | null; lastPlayedAt?: number | null }>,
  continuingIds: Set<string>,
  limit: number,
): T[] {
  if (limit <= 0) return [];
  const entryById = new Map(allEntries.map((entry) => [entry.id, entry]));
  const progressById = new Map(allProgress.map((item) => [item.mediaEntryId, item]));
  const continuingFolders = new Set<string>();
  for (const id of continuingIds) {
    const entry = entryById.get(id);
    if (entry) continuingFolders.add(`${entry.mediaRootId}:${entry.parentId ?? ''}`);
  }
  const siblings = new Map<string, T[]>();
  for (const entry of allEntries) {
    if (!entry.isVideo) continue;
    const key = `${entry.mediaRootId}:${entry.parentId ?? ''}`;
    const group = siblings.get(key) ?? [];
    group.push(entry);
    siblings.set(key, group);
  }
  for (const [key, entries] of siblings) siblings.set(key, sortEntries(entries));

  const handledFolders = new Set<string>();
  const suggestions: T[] = [];
  const watched = allProgress
    .filter((item) => item.watched)
    .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0));
  for (const item of watched) {
    const current = entryById.get(item.mediaEntryId);
    if (!current) continue;
    const key = `${current.mediaRootId}:${current.parentId ?? ''}`;
    if (handledFolders.has(key) || continuingFolders.has(key)) continue;
    handledFolders.add(key);
    const ordered = siblings.get(key) ?? [];
    const currentIndex = ordered.findIndex((entry) => entry.id === current.id);
    if (currentIndex < 0) continue;
    const candidate = ordered.slice(currentIndex + 1).find((entry) => !progressById.get(entry.id)?.watched);
    if (candidate && !continuingIds.has(candidate.id)) suggestions.push(candidate);
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}
