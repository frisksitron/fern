<script lang="ts">
  import Button from '$lib/components/Button.svelte';
  import { trackTitle } from '$lib/music/tracks';
  import { getMusicCatalog } from './catalog.svelte';
  import { getPlaylistActions } from './playlist-actions.svelte';

  const catalog = getMusicCatalog();
  const actions = getPlaylistActions();

  function dismiss(event: MouseEvent) {
    if (event.target === event.currentTarget) actions.addingTracks = null;
  }
</script>

<svelte:window onkeydown={(event) => actions.addingTracks && event.key === 'Escape' && (actions.addingTracks = null)} />

{#if actions.addingTracks}
  {@const tracks = actions.addingTracks}
  <div class="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="presentation" onclick={dismiss}>
    <div
      class="w-full max-w-sm border border-black bg-white p-5 shadow-[6px_6px_0_#000]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-to-playlist-title"
    >
      <h2 id="add-to-playlist-title" class="mb-1 text-base font-bold">Add to playlist /</h2>
      <p class="mb-5 truncate text-sm text-[#6b6b67]">
        {tracks.length === 1 ? trackTitle(tracks[0]) : `${tracks.length} tracks`}
      </p>
      <div class="-mx-1 grid max-h-[50dvh] gap-1 overflow-y-auto overscroll-contain px-1">
        {#each catalog.playlists as playlist (playlist.id)}
          <button
            class="min-h-11 cursor-pointer border-0 border-b border-dotted border-black bg-white px-3 text-left text-[#065ec9] hover:bg-[#e8e8e2]"
            onclick={() => actions.addTo(playlist.id)}
          >
            {playlist.name}
          </button>
        {:else}
          <p class="py-4 text-sm text-[#6b6b67]">Create a playlist first.</p>
        {/each}
      </div>
      <div class="mt-5 flex justify-between">
        <Button variant="ghost" onclick={() => actions.addToNew()}>New playlist</Button>
        <Button variant="secondary" onclick={() => (actions.addingTracks = null)}>Cancel</Button>
      </div>
    </div>
  </div>
{/if}
