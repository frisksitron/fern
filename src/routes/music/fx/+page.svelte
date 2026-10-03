<script lang="ts">
  import { onMount } from 'svelte';
  import { closeMusicFx } from '$lib/client/music-fx';
  import { currentMusicTrackId } from '$lib/client/music-player';
  import FxStage from '$lib/components/music/fx/FxStage.svelte';

  // The page steps aside for the effect (see the styles below).
  onMount(() => {
    document.documentElement.dataset.musicFx = '';
    return () => delete document.documentElement.dataset.musicFx;
  });

  function leaveOnEscape(event: KeyboardEvent) {
    if (event.key === 'Escape' && !event.defaultPrevented) closeMusicFx();
  }
</script>

<svelte:window onkeydown={leaveOnEscape} />

<main>
  <h1 class="sr-only">Visual effects</h1>
  <button
    class="fx-label fixed top-3 left-3 z-10 cursor-pointer border-0 px-2 py-1 text-xs font-semibold tracking-[.08em] uppercase"
    onclick={closeMusicFx}>← Back <span class="font-normal">(Esc)</span></button
  >
  {#if $currentMusicTrackId}
    <FxStage />
  {:else}
    <p class="grid min-h-dvh place-items-center px-4 text-sm">
      <span>Nothing is playing. <a class="text-fern-accent underline" href="/music">Back to music</a></span>
    </p>
  {/if}
</main>

<style>
  /* The effect sets the page's colour, and draws behind the page. */
  :global(html[data-music-fx]) {
    background: var(--fx-background, var(--color-fern-bg));
    transition: background-color 0.4s;
  }

  :global(html[data-music-fx] body) {
    background: transparent;
  }

  /* The player sits in the middle, so the effect radiates out all round it. */
  :global(html[data-music-fx] [data-fx-player]) {
    top: 50%;
    bottom: auto;
    margin-bottom: 0;
    translate: 0 -50%;
  }

  /* Labels over the effect, readable on light pages and dark ones. */
  :global(.fx-label) {
    background: color-mix(in srgb, var(--fx-background, var(--color-fern-bg)) 90%, transparent);
    color: #6b6b67;
  }

  :global(.fx-label:hover) {
    color: #171717;
  }

  :global(html[data-fx-dark] .fx-label) {
    color: #9aa4bf;
  }

  :global(html[data-fx-dark] .fx-label:hover) {
    color: #ffffff;
  }
</style>
