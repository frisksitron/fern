<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { beforeNavigate, goto } from '$app/navigation';
  import * as data from '$lib/client/zero/data';
  import { readProfileId } from '$lib/client/profile';
  import { WatchController, subtitleLabel, subtitleUrl } from '$lib/client/playback/watch-controller.svelte';

  let { mediaId }: { mediaId: string } = $props();

  const loadingMessages = [
    'Scouting beyond the loading wall for the next segment…',
    'Equipping the maneuver gear for a faster stream…',
    'Waiting for the gates to finish buffering…',
    'Gathering enough cursed energy for the next frame…',
    'Expanding the domain of available bandwidth…',
    'Sending the strongest sorcerer to inspect the codec…',
    'Linking into the next playback floor…',
    'Clearing the buffering boss before playback begins…',
    'Checking that the logout button still works…',
    'Sending shadow clones to gather video segments…',
    'Using total concentration to stabilize the stream…',
    'Preparing an equivalent exchange: bandwidth for frames…',
    'Searching the Grand Line for the missing segment…',
    'Gathering seven buffer fragments to summon the next scene…',
    'Charging the stream beyond its current limit…',
    'Pulling the cord on the next video segment…',
    'Sending a tiny electric companion to recharge the player…',
    'Synchronizing the player before launch…',
    'Applying a little Nen to the loading queue…',
    'Opening a gateway to the next video segment…',
    'Sending the telepath to find out what loads next…',
    'Taking a brief ten-year detour to fetch the next frame…',
    'Charging the mana-powered projector…',
    'Sending a familiar to fetch the next scene…',
    'Teaching the pixels their special move…',
    'Convincing the video spirit to cooperate…',
    'Unrolling the ancient playback scroll…',
    'Asking the opening theme to wait patiently…',
    'Making sure the beach episode is properly buffered…',
    'Consulting the wise old codec master…',
    'Preparing snacks for the next adventure…',
    'Waiting for the animation cells to line up…',
  ];

  // The watch page remounts this component for each media ID, so the initial value is the only one.
  // svelte-ignore state_referenced_locally
  const player = new WatchController<HTMLVideoElement>(mediaId, {
    data,
    // Server rendering only renders the loading state; playback starts in the browser.
    profileId: browser ? readProfileId() : '',
    fetch: (input, init) => fetch(input, init),
    createHls: async () => new (await import('hls.js')).default(),
    navigate: (url) => goto(url),
    document: browser ? document : undefined,
  });
  let video: HTMLVideoElement;
  let audioMenuOpen = $state(false);
  let subtitleMenuOpen = $state(false);
  let loadingMessage = $state(loadingMessages[0]);

  onMount(() => {
    chooseLoadingMessage();
    const loadingTimer = setInterval(chooseLoadingMessage, 3_000);
    document.addEventListener('fullscreenchange', syncPlayerOrientation);
    void import('media-chrome').then(() => player.start(video));
    return () => {
      clearInterval(loadingTimer);
      document.removeEventListener('fullscreenchange', syncPlayerOrientation);
      player.destroy();
    };
  });

  // The episode's name and a frame on the lock screen and in the media notification.
  $effect(() => {
    const entry = player.entry;
    if (!entry || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    const frame = `/api/media/${entry.id}/thumbnail?positionMs=${Math.round((entry.durationMs ?? 0) * 0.3)}`;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: entry.name,
      artwork: [{ src: new URL(frame, location.origin).href }],
    });
    return () => {
      navigator.mediaSession.metadata = null;
    };
  });

  // Android's back button closes the audio or subtitle menu before it leaves the player.
  beforeNavigate(({ type, cancel }) => {
    if (type !== 'popstate' || (!audioMenuOpen && !subtitleMenuOpen)) return;
    cancel();
    audioMenuOpen = false;
    subtitleMenuOpen = false;
  });

  function chooseLoadingMessage() {
    const next = loadingMessages.filter((message) => message !== loadingMessage);
    loadingMessage = next[Math.floor(Math.random() * next.length)];
  }

  function syncPlayerOrientation() {
    const orientation = screen.orientation as
      (ScreenOrientation & { lock?: (value: 'landscape') => Promise<void>; unlock?: () => void }) | undefined;
    if (!orientation) return;
    if (document.fullscreenElement) void orientation.lock?.('landscape').catch(() => undefined);
    else orientation.unlock?.();
  }

  function mediaFolderHref() {
    const entry = player.entry;
    if (!entry) return '/browse';
    return entry.parentId ? `/browse/${entry.mediaRootId}/${entry.parentId}` : `/browse/${entry.mediaRootId}`;
  }

  function chooseAudio(stream: number | null) {
    audioMenuOpen = false;
    subtitleMenuOpen = false;
    player.chooseAudio(stream);
  }

  function chooseSubtitle(index: number | null) {
    subtitleMenuOpen = false;
    audioMenuOpen = false;
    player.chooseSubtitle(index);
  }
</script>

<!-- A tap anywhere but the audio or subtitle menu closes it. -->
<svelte:window
  onpointerdown={(event) => {
    if ((event.target as Element).closest('[data-track-menu]')) return;
    audioMenuOpen = false;
    subtitleMenuOpen = false;
  }}
/>

<main class="fixed inset-0 z-50 overflow-hidden bg-black text-white">
  <media-controller
    class="block h-full w-full bg-black [--media-accent-color:#ff5a1f] [--media-control-hover-background:rgba(255,90,31,.16)] [--media-primary-color:#fff] [--media-range-bar-color:#ff5a1f] [--media-range-thumb-background:#ff5a1f] [--media-range-track-background:rgba(255,90,31,.35)] [--media-secondary-color:#111]"
  >
    <video class="h-full w-full bg-black object-contain" slot="media" bind:this={video} playsinline autoplay>
      {#each player.textSubtitleTracks as track}
        <track
          kind="subtitles"
          src={subtitleUrl(mediaId, track)}
          label={subtitleLabel(track)}
          srclang={track.language ?? 'und'}
        />
      {/each}
    </video>

    <div
      class="pointer-events-none absolute inset-x-0 top-0 z-3 h-32 bg-linear-to-t from-transparent to-black/95 pt-[max(1rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))] text-shadow-lg sm:pt-[max(1.5rem,env(safe-area-inset-top))] sm:pr-[max(2rem,env(safe-area-inset-right))] sm:pl-[max(2rem,env(safe-area-inset-left))]"
    >
      <div class="relative flex items-center justify-between">
        {#if player.entry}<a
            href={mediaFolderHref()}
            class="pointer-events-auto grid size-11 shrink-0 place-items-center rounded-full bg-black/50 no-underline backdrop-blur transition hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            aria-label="Back to media folder"
            ><svg
              class="size-6"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.25"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg
            ></a
          >{/if}
        <h1
          class="absolute left-1/2 max-w-[calc(100%-8rem)] -translate-x-1/2 truncate text-center text-base leading-tight font-medium sm:max-w-[calc(100%-16rem)] sm:text-2xl"
        >
          {player.entry?.name ?? 'Loading…'}
        </h1>
        {#if player.nextEntry}
          <button
            class="pointer-events-auto ml-auto flex h-11 cursor-pointer items-center gap-2 rounded-md border-0 bg-black/50 px-3 font-medium text-white backdrop-blur transition hover:bg-white/20 disabled:cursor-wait disabled:opacity-50 sm:px-4"
            aria-label={`Finish and play ${player.nextEntry.name}`}
            title={`Next: ${player.nextEntry.name}`}
            disabled={player.skipping}
            onclick={() => player.skipToNext()}
          >
            <span class="max-sm:hidden">Next</span>
            <svg class="size-6" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
              ><path d="M6 5.5v13l9-6.5-9-6.5Zm10 0h2v13h-2v-13Z" /></svg
            >
          </button>
        {/if}
      </div>
    </div>

    {#if player.loading}<div
        class="absolute inset-0 z-2 grid place-content-center justify-items-center gap-4 bg-black/70 text-center text-zinc-400"
      >
        <span class="size-10 animate-spin rounded-full border-3 border-zinc-700 border-t-fern-accent"></span><span
          role="status"
          aria-live="polite">{loadingMessage}</span
        >
      </div>{/if}
    {#if player.error}<div
        class="absolute inset-0 z-2 grid place-content-center justify-items-center gap-4 bg-black/70 px-5 text-center"
      >
        <strong class="text-2xl sm:text-4xl">Unable to play this video</strong><span class="max-w-xl text-zinc-400"
          >{player.error}</span
        ><a
          class="rounded-md bg-fern-accent-strong px-5 py-3 text-sm font-semibold text-white no-underline transition hover:bg-fern-accent-strong-hover active:scale-[.98]"
          href={mediaFolderHref()}>Back to media folder</a
        >
      </div>{/if}

    <media-control-bar
      class="absolute inset-x-0 bottom-0 z-4 flex w-full items-center gap-1 bg-linear-to-b from-transparent to-black/95 pt-10 pr-[max(0.5rem,env(safe-area-inset-right))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.5rem,env(safe-area-inset-left))] [--media-control-background:transparent] sm:pt-14 sm:pr-[max(1.25rem,env(safe-area-inset-right))] sm:pb-[max(1rem,env(safe-area-inset-bottom))] sm:pl-[max(1.25rem,env(safe-area-inset-left))]"
    >
      <media-play-button class="player-control w-11 hover:bg-white/15"></media-play-button>
      <media-seek-backward-button class="player-control w-11 hover:bg-white/15" seekoffset="10"
      ></media-seek-backward-button>
      <media-seek-forward-button class="player-control w-11 hover:bg-white/15 max-sm:hidden" seekoffset="10"
      ></media-seek-forward-button>
      <!-- Phones set the volume with their buttons; the room goes to rewinding 10 s instead. -->
      <media-mute-button class="player-control w-11 hover:bg-white/15 max-sm:hidden"></media-mute-button>
      <media-volume-range class="player-control player-passive w-24 max-sm:hidden"></media-volume-range>
      <media-time-display class="player-passive whitespace-nowrap text-xs max-sm:hidden" showduration
      ></media-time-display>
      <media-time-range class="player-passive min-w-24 flex-1"></media-time-range>
      {#if player.plan && !player.error && player.plan.audioTracks.length > 1}
        <div class="relative grid place-items-center" data-track-menu>
          <button
            class={[
              'player-control grid w-11 cursor-pointer place-items-center border-0 bg-transparent text-lg font-black text-white hover:bg-white/15',
              player.selectedAudio !== null && 'text-fern-accent',
            ]}
            aria-label="Audio tracks"
            aria-expanded={audioMenuOpen}
            onclick={() => {
              audioMenuOpen = !audioMenuOpen;
              subtitleMenuOpen = false;
            }}>♪</button
          >
          {#if audioMenuOpen}
            <div
              class="absolute right-0 bottom-full mb-3 max-h-[45vh] w-64 overflow-y-auto rounded-lg border border-white/10 bg-zinc-900/95 p-2 shadow-2xl backdrop-blur-xl"
              role="menu"
            >
              <strong class="block px-3 py-2 text-xs font-semibold tracking-wider text-zinc-400 uppercase">Audio</strong
              >
              <button
                class={[
                  'w-full cursor-pointer rounded-md border-0 bg-transparent px-3 py-2 text-left text-sm text-zinc-200 hover:bg-white/10',
                  player.selectedAudio === null && 'bg-fern-accent-strong text-white hover:bg-fern-accent-strong',
                ]}
                onclick={() => chooseAudio(null)}>Default</button
              >
              {#each player.plan.audioTracks as track}
                <button
                  class={[
                    'w-full cursor-pointer rounded-md border-0 bg-transparent px-3 py-2 text-left text-sm text-zinc-200 hover:bg-white/10',
                    player.selectedAudio === track.streamIndex &&
                      'bg-fern-accent-strong text-white hover:bg-fern-accent-strong',
                  ]}
                  onclick={() => chooseAudio(track.streamIndex)}
                  >{track.title ?? track.language ?? `${track.codec} ${track.channels ?? ''}`}</button
                >
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      {#if player.plan && !player.error && player.textSubtitleTracks.length}
        <div class="relative grid place-items-center" data-track-menu>
          <button
            class={[
              'player-control grid w-11 cursor-pointer place-items-center border-0 bg-transparent text-xs font-black text-white hover:bg-white/15',
              player.selectedSubtitle !== null && 'text-fern-accent',
            ]}
            aria-label="Subtitles"
            aria-expanded={subtitleMenuOpen}
            onclick={() => {
              subtitleMenuOpen = !subtitleMenuOpen;
              audioMenuOpen = false;
            }}>CC</button
          >
          {#if subtitleMenuOpen}
            <div
              class="absolute right-0 bottom-full mb-3 max-h-[45vh] w-64 overflow-y-auto rounded-lg border border-white/10 bg-zinc-900/95 p-2 shadow-2xl backdrop-blur-xl"
              role="menu"
            >
              <strong class="block px-3 py-2 text-xs font-semibold tracking-wider text-zinc-400 uppercase"
                >Subtitles</strong
              >
              <button
                class={[
                  'w-full cursor-pointer rounded-md border-0 bg-transparent px-3 py-2 text-left text-sm text-zinc-200 hover:bg-white/10',
                  player.selectedSubtitle === null && 'bg-fern-accent-strong text-white hover:bg-fern-accent-strong',
                ]}
                onclick={() => chooseSubtitle(null)}>Off</button
              >
              {#each player.textSubtitleTracks as track, index}
                <button
                  class={[
                    'w-full cursor-pointer rounded-md border-0 bg-transparent px-3 py-2 text-left text-sm text-zinc-200 hover:bg-white/10',
                    player.selectedSubtitle === index && 'bg-fern-accent-strong text-white hover:bg-fern-accent-strong',
                  ]}
                  onclick={() => chooseSubtitle(index)}>{subtitleLabel(track)}</button
                >
              {/each}
            </div>
          {/if}
        </div>
      {/if}
      <media-playback-rate-button class="player-control w-11 hover:bg-white/15 max-sm:hidden"
      ></media-playback-rate-button>
      <media-pip-button class="player-control w-11 hover:bg-white/15 max-sm:hidden"></media-pip-button>
      <media-fullscreen-button class="player-control w-11 hover:bg-white/15"></media-fullscreen-button>
    </media-control-bar>
  </media-controller>
</main>
