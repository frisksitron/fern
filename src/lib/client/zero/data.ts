import type { ErroredQuery, ResultType } from '@rocicorp/zero';
import { createId, getZero, mutate } from './client';
import { queries } from '$lib/zero/queries';
import { mutators } from '$lib/zero/mutators';
import { QUERY_ID_LIMIT } from '$lib/zero/limits';
import type { MediaEntry, MediaRoot, PlaybackProgress, Playlist, PlaylistItem, Profile } from '$lib/zero/schema';

export type { MediaEntry, MediaRoot, PlaybackProgress, Playlist, PlaylistItem, Profile } from '$lib/zero/schema';

export type SyncStatus = ResultType;
export type SyncError = ErroredQuery;
/**
 * Receives a query's rows. While Zero synchronizes, `unknown` results can be partial, so views that
 * start from the server's rows keep them until a `complete` result: otherwise rows appear and move
 * under the pointer, and a click lands on a different item.
 */
export type QueryListener<T> = (data: T, resultType: SyncStatus, error?: SyncError) => void;

function cleanup(removeListener: () => void, destroy: () => void) {
  return () => {
    removeListener();
    destroy();
  };
}

export function watchProfiles(listener: QueryListener<readonly Profile[]>) {
  const view = getZero().materialize(queries.profiles.all());
  return cleanup(
    view.addListener((data, resultType, error) => listener(data, resultType, error)),
    () => view.destroy(),
  );
}

export function watchMediaRoots(listener: QueryListener<readonly MediaRoot[]>, mediaType?: 'video' | 'music') {
  if (mediaType) {
    const view = getZero().materialize(queries.mediaRoots.byType({ mediaType }));
    return cleanup(
      view.addListener((data, resultType, error) => listener(data, resultType, error)),
      () => view.destroy(),
    );
  }

  const view = getZero().materialize(queries.mediaRoots.all());
  return cleanup(
    view.addListener((data, resultType, error) => listener(data, resultType, error)),
    () => view.destroy(),
  );
}

export function watchMusicSearch(text: string, listener: QueryListener<readonly MediaEntry[]>) {
  const view = getZero().materialize(queries.mediaEntries.searchMusic({ text }));
  return cleanup(
    view.addListener((data, resultType, error) => listener(data, resultType, error)),
    () => view.destroy(),
  );
}

function chunks(ids: readonly string[]) {
  const result: string[][] = [];
  for (let index = 0; index < ids.length; index += QUERY_ID_LIMIT)
    result.push(ids.slice(index, index + QUERY_ID_LIMIT));
  return result;
}

/** Watches one query per chunk of IDs and reports the merged rows. */
function watchByIds<T>(
  ids: readonly string[],
  watchChunk: (chunk: string[], listener: QueryListener<readonly T[]>) => () => void,
  listener: QueryListener<readonly T[]>,
) {
  const parts = chunks([...new Set(ids)]);
  if (!parts.length) {
    listener([], 'complete');
    return () => {};
  }
  const results = parts.map(() => ({ data: [] as readonly T[], resultType: 'unknown' as SyncStatus }));
  const cleanups = parts.map((part, index) =>
    watchChunk(part, (data, resultType, error) => {
      results[index] = { data, resultType };
      const merged = results.flatMap((result) => result.data);
      if (results.some((result) => result.resultType === 'error')) listener(merged, 'error', error);
      else listener(merged, results.every((result) => result.resultType === 'complete') ? 'complete' : 'unknown');
    }),
  );
  return () => cleanups.forEach((stop) => stop());
}

export function watchMediaEntriesByIds(ids: readonly string[], listener: QueryListener<readonly MediaEntry[]>) {
  return watchByIds(
    ids,
    (chunk, onChunk) => {
      const view = getZero().materialize(queries.mediaEntries.byIds({ ids: chunk }));
      return cleanup(
        view.addListener((data, resultType, error) => onChunk(data, resultType, error)),
        () => view.destroy(),
      );
    },
    listener,
  );
}

export async function loadMediaEntriesByIds(ids: readonly string[]) {
  const results = await Promise.all(
    chunks([...new Set(ids)]).map((chunk) =>
      getZero().run(queries.mediaEntries.byIds({ ids: chunk }), { type: 'complete' }),
    ),
  );
  return results.flat();
}

export function watchMediaEntry(id: string, listener: QueryListener<MediaEntry | undefined>) {
  const view = getZero().materialize(queries.mediaEntries.byId({ id }));
  return cleanup(
    view.addListener((data, resultType, error) => listener(data, resultType, error)),
    () => view.destroy(),
  );
}

export function watchChildren(rootId: string, parentId: string | null, listener: QueryListener<readonly MediaEntry[]>) {
  const view = getZero().materialize(queries.mediaEntries.children({ rootId, parentId }));
  return cleanup(
    view.addListener((data, resultType, error) => listener(data, resultType, error)),
    () => view.destroy(),
  );
}

export function watchMusicChildren(
  rootId: string,
  parentId: string | null,
  listener: QueryListener<readonly MediaEntry[]>,
) {
  const view = getZero().materialize(queries.mediaEntries.musicChildren({ rootId, parentId }));
  return cleanup(
    view.addListener((data, resultType, error) => listener(data, resultType, error)),
    () => view.destroy(),
  );
}

export function watchPlaylists(profileId: string, listener: QueryListener<readonly Playlist[]>) {
  const view = getZero().materialize(queries.playlists.forProfile({ profileId }));
  return cleanup(
    view.addListener((data, resultType, error) => listener(data, resultType, error)),
    () => view.destroy(),
  );
}

export function watchPlaylistItems(playlistId: string, listener: QueryListener<readonly PlaylistItem[]>) {
  const view = getZero().materialize(queries.playlistItems.forPlaylist({ playlistId }));
  return cleanup(
    view.addListener((data, resultType, error) => listener(data, resultType, error)),
    () => view.destroy(),
  );
}

export function watchContinueWatching(profileId: string, listener: QueryListener<readonly PlaybackProgress[]>) {
  const view = getZero().materialize(queries.progress.continueWatching({ profileId }));
  return cleanup(
    view.addListener((data, resultType, error) => listener(data, resultType, error)),
    () => view.destroy(),
  );
}

export function watchRecentlyWatched(profileId: string, listener: QueryListener<readonly PlaybackProgress[]>) {
  const view = getZero().materialize(queries.progress.recentlyWatched({ profileId }));
  return cleanup(
    view.addListener((data, resultType, error) => listener(data, resultType, error)),
    () => view.destroy(),
  );
}

export function watchProgressForMedia(
  profileId: string,
  ids: readonly string[],
  listener: QueryListener<readonly PlaybackProgress[]>,
) {
  return watchByIds(
    ids,
    (chunk, onChunk) => {
      const view = getZero().materialize(queries.progress.forMediaIds({ profileId, ids: chunk }));
      return cleanup(
        view.addListener((data, resultType, error) => onChunk(data, resultType, error)),
        () => view.destroy(),
      );
    },
    listener,
  );
}

export function watchProgress(
  profileId: string,
  mediaEntryId: string,
  listener: QueryListener<PlaybackProgress | undefined>,
) {
  const view = getZero().materialize(queries.progress.forMedia({ profileId, mediaEntryId }));
  return cleanup(
    view.addListener((data, resultType, error) => listener(data, resultType, error)),
    () => view.destroy(),
  );
}

export function loadMediaEntry(id: string) {
  return getZero().run(queries.mediaEntries.byId({ id }), { type: 'complete' });
}

export function loadChildren(rootId: string, parentId: string | null) {
  return getZero().run(queries.mediaEntries.children({ rootId, parentId }), {
    type: 'complete',
  });
}

export function loadProgress(profileId: string, mediaEntryId: string) {
  return getZero().run(queries.progress.forMedia({ profileId, mediaEntryId }), {
    type: 'complete',
  });
}

export function loadPlaylistItems(playlistId: string) {
  return getZero().run(queries.playlistItems.forPlaylist({ playlistId }), {
    type: 'complete',
  });
}

export function createProfile(name: string, avatarKey: string) {
  return mutate(
    mutators.profiles.create({
      id: createId(),
      name,
      avatarKey,
      now: Date.now(),
    }),
  );
}

export function updateProfile(id: string, changes: { name?: string; avatarKey?: string }) {
  return mutate(mutators.profiles.update({ id, ...changes, now: Date.now() }));
}

export function deleteProfile(id: string) {
  return mutate(mutators.profiles.delete({ id }));
}

export async function createPlaylist(profileId: string, name: string) {
  const id = createId();
  await mutate(mutators.playlists.create({ id, profileId, name, now: Date.now() }), 'server');
  return id;
}

export function deletePlaylist(id: string) {
  return mutate(mutators.playlists.delete({ id }), 'server');
}

export function renamePlaylist(id: string, name: string) {
  return mutate(mutators.playlists.rename({ id, name, now: Date.now() }), 'server');
}

export function addTracksToPlaylist(playlistId: string, mediaEntryIds: readonly string[]) {
  return mutate(
    mutators.playlists.addTracks({
      playlistId,
      tracks: mediaEntryIds.map((mediaEntryId) => ({ id: createId(), mediaEntryId })),
      now: Date.now(),
    }),
    'server',
  );
}

export function addTrackToPlaylist(playlistId: string, mediaEntryId: string) {
  return addTracksToPlaylist(playlistId, [mediaEntryId]);
}

/** Removes playlist items by their item IDs. */
export function removeFromPlaylist(itemIds: readonly string[]) {
  return mutate(mutators.playlists.removeTracks({ ids: itemIds }), 'server');
}

/** Saves a playlist's order; `itemIds` lists every item of the playlist once. */
export function reorderPlaylist(playlistId: string, itemIds: readonly string[]) {
  return mutate(mutators.playlists.reorder({ playlistId, itemIds }), 'server');
}

export function reorderMedia(rootId: string, parentId: string | null, entryIds: string[]) {
  return mutate(mutators.mediaEntries.reorder({ rootId, parentId, entryIds }), 'server');
}

export function removePlaybackProgress(profileId: string, mediaEntryId: string) {
  return mutate(mutators.progress.remove({ profileId, mediaEntryId }));
}

export function setPlaybackWatched(profileId: string, mediaEntryId: string, watched: boolean) {
  return mutate(
    mutators.progress.setWatched({
      profileId,
      mediaEntryId,
      watched,
      now: Date.now(),
    }),
  );
}

export function savePlaybackProgress(input: {
  profileId: string;
  mediaEntryId: string;
  positionMs: number;
  durationMs: number | null;
  watched?: boolean;
}) {
  return mutate(mutators.progress.save({ ...input, now: Date.now() }));
}

/** Records one listen to a song for the profile (see `PlayCounter`). */
export function recordTrackPlay(profileId: string, mediaEntryId: string) {
  return mutate(mutators.plays.record({ id: createId(), profileId, mediaEntryId, now: Date.now() }));
}
