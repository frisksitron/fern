<script lang="ts">
  import MusicFolderView from '$lib/components/music/MusicFolderView.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

{#key data.folder.rootId}
  <MusicFolderView rootId={data.folder.rootId} initial={data.folder} />
{/key}
