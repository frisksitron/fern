<script lang="ts">
  import { page } from '$app/state';
  import { resolve } from '$app/paths';
  import { musicRoute } from '$lib/music/paths';
  import MusicBrowseLink from './MusicBrowseLink.svelte';
  import { getBrowseMemory } from './browse-memory.svelte';
  import { getMusicCatalog } from './catalog.svelte';
  import { getPlaylistActions } from './playlist-actions.svelte';

  const catalog = getMusicCatalog();
  const browse = getBrowseMemory();
  const actions = getPlaylistActions();
  const route = $derived(musicRoute(page.url.pathname, browse.href));

  function playlistClass(id: string) {
    if (actions.dropTargetId === id) return 'text-fern-accent underline';
    if (route.activePlaylistId === id) return 'text-fern-accent';
    return 'text-[#065ec9] hover:underline';
  }
</script>

<div class="mb-2 flex items-center gap-5 border-b border-dotted border-black pb-1 lg:hidden">
  <nav class="flex gap-5 font-semibold [&>a]:inline-flex [&>a]:min-h-11 [&>a]:items-center" aria-label="Music">
    <MusicBrowseLink
      class={route.browsing ? 'text-fern-accent no-underline' : 'text-[#065ec9] no-underline hover:underline'}
      pathname={route.browseHref}>Browse</MusicBrowseLink
    >
    <a
      class={route.searching ? 'text-fern-accent no-underline' : 'text-[#065ec9] no-underline hover:underline'}
      href={resolve('/music/search')}>Search</a
    >
  </nav>
</div>
<!-- The strip fades at the right edge, so a clipped name reads as "scroll for more". -->
<nav
  class="mb-4 flex gap-6 overflow-x-auto overscroll-x-contain pr-8 pb-2 font-semibold [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] [scrollbar-width:none] sm:mb-6 [&::-webkit-scrollbar]:hidden lg:hidden"
  aria-label="Playlists"
>
  <button
    class="min-h-10 shrink-0 cursor-pointer border-0 bg-transparent p-0 text-fern-accent hover:underline"
    onclick={() => actions.create()}
  >
    + New playlist
  </button>
  {#each catalog.playlists as playlist (playlist.id)}
    <a
      class={['inline-flex min-h-10 shrink-0 items-center no-underline', playlistClass(playlist.id)]}
      href={resolve('/music/playlist/[playlist]', { playlist: playlist.id })}
      oncontextmenu={(event) => actions.openPlaylistMenu(event, playlist)}
      ondragover={(event) => actions.dragOver(event, playlist.id)}
      ondragleave={() => actions.dragLeave(playlist.id)}
      ondrop={(event) => actions.dropOnPlaylist(event, playlist)}
    >
      {playlist.name}
    </a>
  {/each}
</nav>
