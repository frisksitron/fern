<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import Header from '$lib/components/Header.svelte';
  import { currentMusicTrackId } from '$lib/client/music-player';
  import { readProfileId } from '$lib/client/profile';
  import AddToPlaylistDialog from './AddToPlaylistDialog.svelte';
  import { getBrowseMemory } from './browse-memory.svelte';
  import { getMusicCatalog } from './catalog.svelte';
  import MusicMenu from './MusicMenu.svelte';
  import MusicMobileNav from './MusicMobileNav.svelte';
  import MusicSidebar from './MusicSidebar.svelte';
  import { getPlaylistActions } from './playlist-actions.svelte';

  let { children }: { children: Snippet } = $props();
  const catalog = getMusicCatalog();
  const browse = getBrowseMemory();
  const actions = getPlaylistActions();
  let hydrated = $state(false);

  onMount(() => {
    hydrated = true;
    browse.restore();
    return catalog.connect(readProfileId());
  });

  // Android's back button closes a menu or the playlist picker rather than leaving the page.
  beforeNavigate(({ type, cancel }) => {
    if (type !== 'popstate' || (!actions.menu && !actions.addingTracks)) return;
    cancel();
    actions.closeMenu();
    actions.addingTracks = null;
  });

  function closeMenu() {
    actions.closeMenu();
  }

  function closeMenuOnEscape(event: KeyboardEvent) {
    if (event.key === 'Escape') actions.closeMenu();
  }
</script>

<svelte:window onclick={closeMenu} onkeydown={closeMenuOnEscape} />

<Header />
<div
  class={[
    'mx-auto grid max-w-[1168px] gap-8 px-4 pt-4 sm:px-6 sm:pt-12 md:px-10 lg:grid-cols-[220px_1fr]',
    // Room to scroll the last songs above the player (and the home indicator under it).
    $currentMusicTrackId ? 'pb-[calc(8rem+env(safe-area-inset-bottom))] sm:pb-48' : 'pb-12',
  ]}
>
  <MusicSidebar />
  <main class="min-w-0" data-hydrated={hydrated}>
    <MusicMobileNav />
    {#if catalog.message}
      <p class="mb-5 border border-[#b42318] bg-[#fff0ed] px-4 py-3 text-sm text-[#b42318]" role="alert">
        {catalog.message}
      </p>
    {/if}
    {@render children()}
  </main>
</div>
<MusicMenu />
<AddToPlaylistDialog />
