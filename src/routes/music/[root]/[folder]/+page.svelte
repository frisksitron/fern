<script lang="ts">
  import MusicFolderView from '$lib/components/music/MusicFolderView.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

{#key `${data.folder.rootId}:${data.folder.folderId}`}
  <MusicFolderView rootId={data.folder.rootId} folderId={data.folder.folderId} initial={data.folder} />
{/key}
