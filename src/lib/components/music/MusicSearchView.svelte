<script lang="ts">
  import { replaceState } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import MusicTrackList from '$lib/components/music/MusicTrackList.svelte';
  import SectionHeading from '$lib/components/SectionHeading.svelte';
  import { playMusic } from '$lib/client/music-player';
  import { watchMusicSearch, type MediaEntry } from '$lib/client/zero/data';
  import { MUSIC_SEARCH_LIMIT } from '$lib/zero/limits';
  import { getMusicCatalog } from './catalog.svelte';
  import { getPlaylistActions } from './playlist-actions.svelte';

  const catalog = getMusicCatalog();
  const actions = getPlaylistActions();
  let query = $derived(page.url.searchParams.get('q') ?? '');
  /** The text being searched: the query after the typing pause. */
  let searched = $state('');
  let results = $state<readonly MediaEntry[]>([]);
  let resultsLoaded = $state(false);

  $effect(() => {
    const next = query;
    const timer = setTimeout(() => {
      publishQuery(next);
      searched = next.trim();
    }, 200);
    return () => clearTimeout(timer);
  });

  // The server returns at most MUSIC_SEARCH_LIMIT matches, so only those synchronize. The previous
  // results stay (dimmed) until the new search completes, so the list does not empty and refill.
  $effect(() => {
    const text = searched;
    actions.clearSelection();
    resultsLoaded = false;
    if (!text) {
      results = [];
      return;
    }
    return watchMusicSearch(text, (rows, resultType, error) => {
      if (resultType === 'complete') {
        results = rows;
        resultsLoaded = true;
      }
      if (resultType === 'error') catalog.message = error?.message ?? 'Could not search music.';
    });
  });

  let stale = $derived(!resultsLoaded || searched !== query.trim());

  function publishQuery(next: string) {
    const url = new URL(page.url);
    const current = url.searchParams.get('q') ?? '';
    if (next === current) return;
    const search = next ? `?${new URLSearchParams({ q: next })}` : '';
    replaceState(resolve(`/music/search${search}`), page.state);
  }
</script>

<SectionHeading title="Search" />
<label class="mb-6 block">
  <span class="sr-only">Search music</span>
  <input
    class="min-h-11 w-full border border-black bg-white px-3 text-black outline-none placeholder:text-[#777772] focus:outline-2 focus:outline-offset-2 focus:outline-black"
    type="search"
    bind:value={query}
    placeholder="Search tracks, artists, or albums"
    enterkeyhint="search"
    autocomplete="off"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    onkeydown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
  />
</label>
{#if query.trim() && results.length}
  <div class={['transition-opacity', stale && 'opacity-50']} aria-busy={stale}>
    <MusicTrackList
      tracks={results}
      source="search"
      label={`Songs matching ${query.trim()}`}
      onPlay={(track) => playMusic(results, track, { sourceHref: page.url.pathname + page.url.search })}
    />
  </div>
  {#if results.length >= MUSIC_SEARCH_LIMIT}
    <p class="mt-3 text-sm text-[#6b6b67]">
      Showing the first {MUSIC_SEARCH_LIMIT} matches. Refine the search to narrow them.
    </p>
  {/if}
{:else if query.trim() && resultsLoaded && searched === query.trim()}
  <p class="border border-black bg-white px-6 py-12 text-center text-sm text-[#6b6b67]">
    No music found for “{query.trim()}”.
  </p>
{:else if query.trim()}
  <p class="text-sm text-[#6b6b67]">Searching…</p>
{:else}
  <p class="text-sm text-[#6b6b67]">Type a track, artist, or album name.</p>
{/if}
