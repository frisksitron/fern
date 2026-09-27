<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import Dialogs from '$lib/components/Dialogs.svelte';
  import '../app.css';

  let { children }: { children: Snippet } = $props();
  // The watch page is black edge to edge; the browser and system bars follow it there.
  const themeColor = $derived(page.route.id?.startsWith('/watch') ? '#000000' : '#f4f4ef');
</script>

<svelte:head><title>Fern</title><meta name="theme-color" content={themeColor} /></svelte:head>
{@render children()}
<Dialogs />
