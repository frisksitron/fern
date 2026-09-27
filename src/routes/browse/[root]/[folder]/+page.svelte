<script lang="ts">
  import Browser from '$lib/components/Browser.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

{#key `${data.browse.rootId}:${data.browse.folderId}`}
  <Browser rootId={data.browse.rootId} folderId={data.browse.folderId} initial={data.browse} />
{/key}
