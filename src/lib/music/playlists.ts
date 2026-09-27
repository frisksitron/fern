type ExistingItem = { readonly mediaEntryId: string; readonly position: number };

/**
 * What appending songs to a playlist inserts: each song not already in it, once, in the order given,
 * after the current last item. Removing items leaves gaps in positions, so this counts from the
 * highest position rather than the item count. Both Zero's `addTracks` and MCP use it.
 */
export function planPlaylistAppend<Track extends { readonly mediaEntryId: string }>(
  existing: readonly ExistingItem[],
  tracks: readonly Track[],
) {
  const present = new Set(existing.map((item) => item.mediaEntryId));
  const next = existing.reduce((highest, item) => Math.max(highest, item.position), -1) + 1;
  const added: Array<Track & { position: number }> = [];
  const skipped: Track[] = [];
  for (const track of tracks) {
    if (present.has(track.mediaEntryId)) {
      skipped.push(track);
      continue;
    }
    present.add(track.mediaEntryId);
    added.push({ ...track, position: next + added.length });
  }
  return { added, skipped };
}

type OrderableItem = { readonly mediaEntryId: string; readonly position: number };

/**
 * A playlist's items in the order `trackIds` gives. Items whose songs are not listed, such as songs
 * removed from the library (which song lists do not show), keep their order after the listed ones.
 * Also reports listed IDs that are not in the playlist, and IDs listed more than once. The playlist
 * view and MCP's `reorder_playlist` both order this way.
 */
export function planPlaylistOrder<Item extends OrderableItem>(items: readonly Item[], trackIds: readonly string[]) {
  const byTrack = new Map(items.map((item) => [item.mediaEntryId, item]));
  const listedIds = new Set<string>();
  const repeated = new Set<string>();
  const listed: Item[] = [];
  const unknown: string[] = [];
  for (const id of trackIds) {
    if (listedIds.has(id)) {
      repeated.add(id);
      continue;
    }
    listedIds.add(id);
    const item = byTrack.get(id);
    if (item) listed.push(item);
    else unknown.push(id);
  }
  const unlisted = [...items]
    .sort((left, right) => left.position - right.position)
    .filter((item) => !listedIds.has(item.mediaEntryId));
  return { ordered: [...listed, ...unlisted], unlisted, unknown, repeated: [...repeated] };
}
