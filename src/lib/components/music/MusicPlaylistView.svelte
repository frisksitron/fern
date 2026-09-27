<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import MusicTrackList from '$lib/components/music/MusicTrackList.svelte';
  import SectionHeading from '$lib/components/SectionHeading.svelte';
  import { playMusic, reorderMusicQueue } from '$lib/client/music-player';
  import { planPlaylistOrder } from '$lib/music/playlists';
  import {
    removeFromPlaylist,
    reorderPlaylist,
    watchMediaEntriesByIds,
    watchPlaylistItems,
    type MediaEntry,
    type Playlist,
    type PlaylistItem,
  } from '$lib/client/zero/data';
  import { messageFrom } from '$lib/shared/errors';
  import { getMusicCatalog } from './catalog.svelte';
  import { getPlaylistActions } from './playlist-actions.svelte';

  let {
    playlist,
    items: initialItems,
    tracks: initialTracks,
  }: {
    playlist: Playlist;
    items: readonly PlaylistItem[];
    tracks: readonly MediaEntry[];
  } = $props();
  const seededPlaylist = untrack(() => playlist);
  const catalog = getMusicCatalog();
  const actions = getPlaylistActions();

  let items = $state<readonly PlaylistItem[]>(untrack(() => initialItems));
  /** The playlist's tracks, seeded by the server and then synchronized for these items only. */
  let tracks = $state<readonly MediaEntry[]>(untrack(() => initialTracks));
  let itemIdsKey = $derived(items.map((item) => item.mediaEntryId).join(','));
  let active = $derived(catalog.playlists.find((item) => item.id === seededPlaylist.id) ?? seededPlaylist);
  let playlistTracks = $derived.by(() => {
    const byId = new Map(tracks.filter((track) => track.isAudio).map((track) => [track.id, track]));
    return items.map((item) => byId.get(item.mediaEntryId)).filter((track): track is MediaEntry => Boolean(track));
  });

  $effect(() => {
    const ids = itemIdsKey ? itemIdsKey.split(',') : [];
    return watchMediaEntriesByIds(ids, (data, resultType, error) => {
      if (resultType === 'complete') tracks = data;
      if (resultType === 'error') catalog.message = error?.message ?? 'Could not synchronize this playlist.';
    });
  });

  onMount(() => {
    actions.clearSelection();
    return watchPlaylistItems(seededPlaylist.id, (data, resultType, error) => {
      if (resultType === 'complete') items = data;
      if (resultType === 'error') catalog.message = error?.message ?? 'Could not synchronize this playlist.';
    });
  });

  /**
   * Saves the order shown, keeping items whose track is gone (and so not shown) at the end. The list
   * updates at once; a failed save puts the previous order back.
   */
  async function reorder(trackIds: readonly string[]) {
    const previous = items;
    const next = planPlaylistOrder(items, trackIds).ordered;
    items = next.map((item, position) => ({ ...item, position }));
    reorderMusicQueue(active.id, trackIds);
    try {
      await reorderPlaylist(
        active.id,
        next.map((item) => item.id),
      );
    } catch (error) {
      items = previous;
      reorderMusicQueue(
        active.id,
        previous.map((item) => item.mediaEntryId),
      );
      catalog.message = messageFrom(error, 'Could not save the playlist order.');
    }
  }

  async function remove(removed: readonly MediaEntry[]) {
    const trackIds = new Set(removed.map((track) => track.id));
    const itemIds = items.filter((item) => trackIds.has(item.mediaEntryId)).map((item) => item.id);
    if (!itemIds.length) return;
    try {
      await removeFromPlaylist(itemIds);
    } catch (error) {
      catalog.message = messageFrom(error, 'Could not remove the songs.');
    }
  }
</script>

<SectionHeading title={active.name}>
  <button
    class="-my-2 grid size-11 shrink-0 cursor-pointer place-items-center border-0 bg-transparent p-0 text-lg leading-none text-[#414141] hover:text-black focus-visible:outline-2 focus-visible:outline-black"
    aria-label={`Actions for ${active.name}`}
    aria-haspopup="menu"
    onclick={(event) => actions.openPlaylistMenuFromButton(event, active)}>⋯</button
  >
</SectionHeading>
{#if playlistTracks.length}
  <MusicTrackList
    tracks={playlistTracks}
    source="playlist"
    label={`Songs in ${active.name}`}
    onPlay={(track) =>
      playMusic(playlistTracks, track, {
        loop: true,
        playlistId: active.id,
        sourceHref: `/music/playlist/${active.id}`,
      })}
    onRemove={remove}
    onReorder={reorder}
  />
{:else}
  <div class="border border-black bg-white px-6 py-16 text-center text-sm text-[#6b6b67]">
    This playlist is empty. Add songs while browsing or searching.
  </div>
{/if}
