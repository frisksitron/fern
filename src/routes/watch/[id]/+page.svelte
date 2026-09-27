<script lang="ts">
  import { page } from '$app/state';
  import WatchPlayer from '$lib/components/WatchPlayer.svelte';
</script>

<!-- Navigating to the next media reuses this page; the key gives each media its own player. -->
{#key page.params.id}
  <WatchPlayer mediaId={page.params.id!} />
{/key}
