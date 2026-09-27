<script lang="ts">
  import { page } from '$app/state';
  import SectionHeading from '$lib/components/SectionHeading.svelte';
  import { currentMusicPlaylistId, isMusicPlaying } from '$lib/client/music-player';
  import { resolve } from '$app/paths';
  import { musicRoute } from '$lib/music/paths';
  import MusicBrowseLink from './MusicBrowseLink.svelte';
  import type { Playlist } from '$lib/client/zero/data';
  import { getBrowseMemory } from './browse-memory.svelte';
  import { getMusicCatalog } from './catalog.svelte';
  import { getPlaylistActions } from './playlist-actions.svelte';

  const catalog = getMusicCatalog();
  const browse = getBrowseMemory();
  const actions = getPlaylistActions();
  const route = $derived(musicRoute(page.url.pathname, browse.href));

  function playlistClass(id: string) {
    if (actions.dropTargetId === id) return 'text-fern-accent';
    if (route.activePlaylistId === id) return 'font-semibold text-fern-accent';
    return 'text-[#414141] hover:text-fern-accent';
  }
</script>

{#snippet mark(active: boolean)}
  <span class="grid w-4 shrink-0 place-items-center text-[#6b6b67]">{active ? '>' : '#'}</span>
{/snippet}

{#snippet playlistLink(playlist: Playlist)}
  <a
    class={['group flex min-h-10 items-center gap-2 overflow-hidden no-underline', playlistClass(playlist.id)]}
    href={resolve('/music/playlist/[playlist]', { playlist: playlist.id })}
    ondblclick={(event) => {
      event.preventDefault();
      void actions.play(playlist);
    }}
    oncontextmenu={(event) => actions.openPlaylistMenu(event, playlist)}
    ondragover={(event) => actions.dragOver(event, playlist.id)}
    ondragleave={() => actions.dragLeave(playlist.id)}
    ondrop={(event) => actions.dropOnPlaylist(event, playlist)}
  >
    <span class="grid w-4 shrink-0 place-items-center text-[#6b6b67]">
      {#if playlist.id === $currentMusicPlaylistId && $isMusicPlaying}
        <span class="playing-indicator playing text-fern-accent" aria-hidden="true"><i></i><i></i><i></i></span>
      {:else}
        <span>{route.activePlaylistId === playlist.id ? '>' : '#'}</span>
      {/if}
    </span>
    <span class="truncate group-hover:underline">{playlist.name}</span>
  </a>
{/snippet}

<aside class="hidden lg:block">
  <nav class="sticky top-28 text-sm">
    <SectionHeading title="Music" compact />
    <div class="grid gap-1">
      <MusicBrowseLink
        class={[
          'flex min-h-10 items-center gap-2 overflow-hidden font-semibold no-underline',
          route.browsing ? 'text-fern-accent' : 'text-[#414141] hover:text-fern-accent hover:underline',
        ]}
        pathname={route.browseHref}
      >
        {@render mark(route.browsing)}
        <span>Browse</span>
      </MusicBrowseLink>
      <a
        class={[
          'flex min-h-10 items-center gap-2 overflow-hidden font-semibold no-underline',
          route.searching ? 'text-fern-accent' : 'text-[#414141] hover:text-fern-accent hover:underline',
        ]}
        href={resolve('/music/search')}
      >
        {@render mark(route.searching)}
        <span>Search</span>
      </a>
      <div class="mt-4 mb-1 border-b border-dotted border-black pb-3">
        <span class="text-base leading-6 font-bold uppercase">Playlists /</span>
      </div>
      <button
        class={[
          'group flex min-h-10 cursor-pointer items-center gap-2 overflow-hidden border-0 bg-transparent p-0 text-left font-semibold',
          actions.dropTargetId === 'new' ? 'text-fern-accent' : 'text-[#414141] hover:text-fern-accent',
        ]}
        onclick={() => actions.create()}
        ondragover={(event) => actions.dragOver(event, 'new')}
        ondragleave={() => actions.dragLeave('new')}
        ondrop={(event) => actions.dropOnNewPlaylist(event)}
        aria-label="Create playlist"
      >
        <span class="grid w-4 shrink-0 place-items-center">+</span>
        <span class="group-hover:underline">New playlist</span>
      </button>
      {#each catalog.playlists as playlist (playlist.id)}
        {@render playlistLink(playlist)}
      {/each}
    </div>
  </nav>
</aside>
