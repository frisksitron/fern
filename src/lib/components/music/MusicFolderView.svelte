<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import MediaFolderNavigation from '$lib/components/MediaFolderNavigation.svelte';
  import MusicTrackList from '$lib/components/music/MusicTrackList.svelte';
  import { playMusic } from '$lib/client/music-player';
  import { watchMediaRoots, watchMusicChildren, type MediaEntry, type MediaRoot } from '$lib/client/zero/data';
  import type { MediaFolderSnapshot } from '$lib/shared/media-folder-data';
  import { sortEntries } from '$lib/shared/sorting';
  import { getBrowseMemory } from './browse-memory.svelte';
  import { getMusicCatalog } from './catalog.svelte';
  import { getPlaylistActions } from './playlist-actions.svelte';

  let {
    rootId = null,
    folderId = null,
    initial,
  }: {
    rootId?: string | null;
    folderId?: string | null;
    initial: MediaFolderSnapshot;
  } = $props();
  const snapshot = untrack(() => initial);
  const catalog = getMusicCatalog();
  const browse = getBrowseMemory();
  const actions = getPlaylistActions();

  let roots = $state<readonly MediaRoot[]>(snapshot.roots);
  let folder = $state<MediaEntry | null>(snapshot.folder);
  let entries = $state<readonly MediaEntry[]>(snapshot.entries);
  let trail = $state<MediaEntry[]>(snapshot.trail);
  let folderTracks = $derived(entries.filter((entry) => entry.isAudio));
  let directories = $derived(entries.filter((entry) => entry.kind === 'directory'));

  function folderHref() {
    if (!rootId) return undefined;
    return folderId ? `/music/${rootId}/${folderId}` : `/music/${rootId}`;
  }

  onMount(() => {
    actions.clearSelection();
    browse.remember(window.location.pathname);
    const cleanups = [
      watchMediaRoots((data, resultType) => {
        if (resultType === 'complete') roots = data;
      }, 'music'),
    ];
    if (rootId) {
      cleanups.push(
        watchMusicChildren(rootId, folderId, (data, resultType, error) => {
          if (resultType === 'complete') entries = sortEntries(data);
          if (resultType === 'error') catalog.message = error?.message ?? 'Could not synchronize this folder.';
        }),
      );
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  });
</script>

<MediaFolderNavigation
  basePath="/music"
  rootLabel="Music"
  headingLabel="Browse"
  emptyMessage="No music folders are configured."
  addFolderLabel="Add a music folder"
  addFolderHref="/settings/media/add?type=music"
  {rootId}
  {folderId}
  {roots}
  {folder}
  {trail}
  {directories}
  showRootHeading
  draggableFolders
  onFolderDragStart={(event, draggedRootId, draggedFolderId, label) =>
    actions.beginFolderDrag(event, draggedRootId, draggedFolderId, label)}
  onFolderDragEnd={() => actions.endDrag()}
/>
{#if rootId && folderTracks.length}
  <div class="mt-2">
    <MusicTrackList
      tracks={folderTracks}
      source="folder"
      label={`Songs in ${folder?.name ?? 'this folder'}`}
      onPlay={(track) => playMusic(folderTracks, track, { sourceHref: folderHref() })}
    />
  </div>
{/if}
