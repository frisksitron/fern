<script lang="ts">
  import { untrack } from 'svelte';
  import MusicFrame from '$lib/components/music/MusicFrame.svelte';
  import MusicPlayer from '$lib/components/music/MusicPlayer.svelte';
  import { BrowseMemory, setBrowseMemory } from '$lib/components/music/browse-memory.svelte';
  import { MusicCatalog, setMusicCatalog } from '$lib/components/music/catalog.svelte';
  import { PlaylistActions, setPlaylistActions } from '$lib/components/music/playlist-actions.svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();
  const catalog = new MusicCatalog(untrack(() => data.musicShell.playlists));
  const browse = new BrowseMemory();
  const actions = new PlaylistActions(catalog, browse);
  setMusicCatalog(catalog);
  setBrowseMemory(browse);
  setPlaylistActions(actions);
</script>

<div class="min-h-dvh">
  <MusicFrame>
    {@render children()}
  </MusicFrame>
</div>
<MusicPlayer />
