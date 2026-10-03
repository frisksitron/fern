<script lang="ts">
  import { onMount } from 'svelte';
  import { onClockFrame } from '$lib/client/music-clock';
  import { musicPlayer } from '$lib/client/music-player';
  import { trackTitle } from '$lib/music/tracks';
  import { fitCanvas, playerBox } from './canvas';
  import { EFFECTS } from './effects';
  import { FxRenderer } from './renderer';
  import { compileScore, type Score } from './score';
  import type { Song } from './shader';
  import { trackMap } from './track-map';

  /**
   * The FX page's effects, one at a time behind the player; clicking the background (or the arrow
   * keys) goes to the next one. The playing song's map, which the server works out, is compiled
   * into a score (see `score.ts`), and each frame the GPU draws the score at the playback position
   * and nothing else, so the effect follows the seek bar 1-to-1 and holds still while paused.
   */
  const storageKey = 'fern:music-fx';

  let canvas: HTMLCanvasElement;
  let index = $state(0);
  let chosen = $derived(EFFECTS[index]);
  /** Whether the browser can draw the effects, and whether the playing song's score is ready. */
  let supported = $state(true);
  let scoring = $state<'reading' | 'ready' | 'unavailable'>('reading');

  function choose(next: number) {
    index = (next + EFFECTS.length) % EFFECTS.length;
    try {
      localStorage.setItem(storageKey, EFFECTS[index].id);
    } catch {
      // The choice just does not survive a reload.
    }
  }

  function nextOnBackground(event: MouseEvent) {
    if ((event.target as Element).closest('[data-fx-player], a, button, input, [role="dialog"]')) return;
    choose(index + 1);
  }

  function onKey(event: KeyboardEvent) {
    if ((event.target as Element).closest('input, textarea, select, [data-fx-player]')) return;
    if (event.key === 'ArrowRight') choose(index + 1);
    else if (event.key === 'ArrowLeft') choose(index - 1);
  }

  onMount(() => {
    try {
      index = Math.max(
        0,
        EFFECTS.findIndex((effect) => effect.id === localStorage.getItem(storageKey)),
      );
    } catch {
      // Storage is blocked; start with the first.
    }
    const stopFitting = fitCanvas(canvas);
    const renderer = FxRenderer.create(canvas);
    supported = !!renderer;
    if (!renderer) return stopFitting;
    // The one on show first.
    renderer.prepare([EFFECTS[index], ...EFFECTS]);

    /** The playing track, and its score once its map has been fetched and compiled. */
    let playing: string | null = null;
    let score: Score | null = null;
    // The playing song's text, for the effects to write, upper case.
    let song: Song = { title: '', artist: '', album: '' };
    const stopReading = musicPlayer.subscribe(({ queue, index }) => {
      const track = queue[index];
      song = {
        title: track ? trackTitle(track).toUpperCase() : '',
        artist: (track?.artist ?? '').toUpperCase(),
        album: (track?.album ?? '').toUpperCase(),
      };
      if ((track?.id ?? null) !== playing) {
        const id = (playing = track?.id ?? null);
        score = null;
        scoring = 'reading';
        if (id)
          void trackMap(id).then((map) => {
            if (id !== playing) return;
            score = map && compileScore(map);
            scoring = score ? 'ready' : 'unavailable';
          });
      }
      // The next track's map, ahead of time, so its effect starts with it.
      const next = queue[index + 1];
      if (next) void trackMap(next.id);
    });

    const stop = onClockFrame((position) => {
      const effect = EFFECTS[index];
      renderer.draw({ effect, score, position, box: playerBox(), texts: effect.texts?.(song) ?? [] });
    });

    return () => {
      stop();
      stopReading();
      stopFitting();
      renderer.destroy();
    };
  });

  $effect(() => {
    const root = document.documentElement;
    root.style.setProperty('--fx-background', chosen.background);
    root.toggleAttribute('data-fx-dark', !!chosen.dark);
    return () => {
      root.style.removeProperty('--fx-background');
      root.removeAttribute('data-fx-dark');
    };
  });
</script>

<svelte:window onclick={nextOnBackground} onkeydown={onKey} />

<canvas class="pointer-events-none fixed inset-0 -z-10 size-full" bind:this={canvas} aria-hidden="true"></canvas>
<button
  class="fx-label fixed top-3 right-3 z-10 cursor-pointer border-0 px-2 py-1 text-xs font-semibold tracking-[.08em] uppercase"
  onclick={() => choose(index + 1)}
  title="Click the background, or press → or ←, for another effect"
  aria-label={`Effect: ${chosen.name}. Next effect`}
>
  {chosen.name} <span class="font-normal">{index + 1}/{EFFECTS.length} →</span>
</button>
<p class="fixed inset-x-0 bottom-3 z-10 px-4 text-center text-xs" aria-live="polite">
  {#if !supported}
    <span class="fx-label px-2 py-1">This browser cannot draw the visual effects (they need WebGL2).</span>
  {:else if scoring === 'reading'}
    <!-- Only shown if the song takes a moment to read, as it does the first time it plays. -->
    <span class="fx-label fx-status px-2 py-1">Reading the song…</span>
  {:else if scoring === 'unavailable'}
    <span class="fx-label px-2 py-1">This track has no visual effect.</span>
  {/if}
</p>

<style>
  .fx-status {
    animation: fx-appear 0.2s 0.8s both;
  }

  @keyframes fx-appear {
    from {
      opacity: 0;
    }
  }
</style>
