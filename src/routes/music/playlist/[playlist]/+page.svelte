<script lang="ts">
  import MusicPlaylistView from '$lib/components/music/MusicPlaylistView.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

{#key data.playlist.id}
  <MusicPlaylistView playlist={data.playlist} items={data.items} tracks={data.tracks} />
{/key}
