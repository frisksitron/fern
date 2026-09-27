<script lang="ts">
  import Browser from '$lib/components/Browser.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<Browser initial={data.browse} continueWatching={data.continueWatching} />
