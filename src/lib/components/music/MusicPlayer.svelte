<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { page } from '$app/state';
  import {
    musicPlayer,
    nextTrack,
    previousTrack,
    rememberMusicPosition,
    setMusicPlaying,
    toggleShuffle,
  } from '$lib/client/music-player';
  import { registerMusicClock } from '$lib/client/music-clock';
  import { MUSIC_FX_PATH, closeMusicFx, openMusicFx } from '$lib/client/music-fx';
  import { readProfileId } from '$lib/client/profile';
  import { recordTrackPlay } from '$lib/client/zero/data';
  import { PlayCounter } from '$lib/music/plays';

  const volumeStorageKey = 'fern:music-volume';

  let audio = $state<HTMLAudioElement>();
  let elapsed = $state(0);
  let duration = $state(0);
  let volume = $state(0.8);
  let loadedTrackId = '';
  let handledPlayRequest = $musicPlayer.playRequest;
  let handledToggleRequest = $musicPlayer.toggleRequest;
  const playCounter = new PlayCounter();
  let current = $derived($musicPlayer.queue[$musicPlayer.index]);
  let onFxPage = $derived(page.url.pathname === MUSIC_FX_PATH);
  let sourceHref = $derived(
    $musicPlayer.sourceHref ??
      (current ? `/music/${current.mediaRootId}${current.parentId ? `/${current.parentId}` : ''}` : null),
  );

  onMount(() => {
    const storedVolume = localStorage.getItem(volumeStorageKey);
    if (storedVolume === null) return;
    const savedVolume = Number(storedVolume);
    if (Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 1) {
      volume = savedVolume;
      if (audio) audio.volume = volume;
    }
  });

  onDestroy(() => setMusicPlaying(false));

  // The visual effect follows this element's position (see `music-clock.ts`).
  $effect(() => {
    registerMusicClock(audio ?? null);
    return () => registerMusicClock(null);
  });

  // Lock screen, notification, headphone, and car controls.
  const mediaSession = () =>
    typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null;

  onMount(() => {
    const session = mediaSession();
    if (!session) return;
    // No seekbackward/seekforward: iOS would show ±10 s buttons in place of previous and next.
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => play()],
      ['pause', () => audio?.pause()],
      ['previoustrack', previousTrack],
      ['nexttrack', nextTrack],
      ['seekto', (details) => details.seekTime !== undefined && seekTo(details.seekTime)],
    ];
    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // The browser does not support this action.
      }
    };
    for (const [action, handler] of handlers) setHandler(action, handler);
    return () => {
      for (const [action] of handlers) setHandler(action, null);
      session.metadata = null;
      session.playbackState = 'none';
    };
  });

  $effect(() => {
    const session = mediaSession();
    if (!session || !current || typeof MediaMetadata === 'undefined') return;
    session.metadata = new MediaMetadata({
      title: trackTitle(),
      artist: current.artist ?? '',
      album: current.album ?? '',
      artwork: [{ src: new URL(`/api/media/${current.id}/artwork`, location.origin).href }],
    });
  });

  $effect(() => {
    const session = mediaSession();
    if (session) session.playbackState = $musicPlayer.playing ? 'playing' : 'paused';
  });

  /** Keeps the lock screen's scrubber in step; the system extrapolates between updates. */
  function syncPositionState() {
    const session = mediaSession();
    if (!session?.setPositionState || !audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      session.setPositionState({
        duration: audio.duration,
        position: Math.min(audio.currentTime, audio.duration),
        playbackRate: audio.playbackRate || 1,
      });
    } catch {
      // A position outside the duration while a new track loads.
    }
  }

  $effect(() => {
    if (!current || !audio) return;
    const loaded = current.id === loadedTrackId;
    if (!loaded) {
      loadedTrackId = current.id;
      playCounter.reset();
      elapsed = $musicPlayer.position;
      duration = 0;
      audio.src = `/stream/${current.id}`;
      audio.volume = volume;
      audio.load();
    }
    if ($musicPlayer.playRequest > handledPlayRequest) {
      handledPlayRequest = $musicPlayer.playRequest;
      // Playing the loaded track again starts it over (a new track starts at `position` once loaded).
      if (loaded) {
        audio.currentTime = elapsed = $musicPlayer.position;
        playCounter.reset();
      }
      play();
    }
    if ($musicPlayer.toggleRequest > handledToggleRequest) {
      handledToggleRequest = $musicPlayer.toggleRequest;
      toggle();
    }
  });

  /**
   * Starts playback. The browser refuses when autoplay is blocked or the file cannot be played; the
   * player then shows as paused instead of leaving the refusal unhandled.
   */
  function play() {
    audio?.play().catch(() => setMusicPlaying(false));
  }

  function toggle() {
    if (!audio) return;
    if (audio.paused) play();
    else audio.pause();
  }

  function seek(event: Event) {
    seekTo(Number((event.currentTarget as HTMLInputElement).value));
  }

  function seekTo(position: number) {
    if (audio) audio.currentTime = position;
    elapsed = position;
    rememberMusicPosition(position);
  }

  function restorePosition() {
    if (!audio) return;
    duration = audio.duration;
    audio.currentTime = Math.min($musicPlayer.position, Math.max(0, audio.duration - 0.1));
  }

  function playbackTimeUpdate() {
    if (!audio) return;
    elapsed = audio.currentTime;
    rememberMusicPosition(elapsed);
    if (current && !audio.paused && !audio.seeking) countPlay(current.id, current.durationMs);
  }

  /** Records a play once enough of the song has been listened to (see `PlayCounter`). */
  function countPlay(trackId: string, durationMs: number | null) {
    if (!audio) return;
    const knownDurationMs = durationMs ?? (Number.isFinite(audio.duration) ? audio.duration * 1000 : null);
    if (!playCounter.advance(audio.currentTime * 1000, performance.now(), knownDurationMs, audio.playbackRate)) return;
    const profileId = readProfileId();
    // A play that fails to save is not worth interrupting the music for.
    if (profileId) recordTrackPlay(profileId, trackId).catch(() => {});
  }

  function setVolume(event: Event) {
    volume = Number((event.currentTarget as HTMLInputElement).value);
    if (audio) audio.volume = volume;
    localStorage.setItem(volumeStorageKey, String(volume));
  }

  function formatTime(value: number) {
    if (!Number.isFinite(value)) return '0:00';
    const seconds = Math.floor(value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function trackTitle() {
    return current?.title ?? current?.name.replace(/\.[^.]+$/, '') ?? '';
  }

  function rangeProgress(value: number, max: number) {
    return `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%`;
  }

  function audioFormat() {
    return current?.extension?.replace(/^\./, '').toUpperCase() ?? 'AUDIO';
  }

  function isLossless() {
    const format = current?.extension?.replace(/^\./, '').toLowerCase() ?? '';
    const codec = current?.audioCodecSummary?.toLowerCase() ?? '';
    return (
      ['flac', 'alac', 'wav', 'aiff', 'ape'].includes(format) ||
      ['flac', 'alac', 'ape'].includes(codec) ||
      codec.startsWith('pcm_')
    );
  }

  function isHighResolution() {
    return isLossless() && ((current?.audioBitDepth ?? 0) > 16 || (current?.audioSampleRate ?? 0) > 48_000);
  }

  function formatSampleRate(value: number) {
    const kilohertz = value / 1000;
    return `${Number.isInteger(kilohertz) ? kilohertz : kilohertz.toFixed(1)} KHZ`;
  }

  function formatBitrate(value: number) {
    return `${Math.round(value / 1000)} KBPS`;
  }
</script>

{#if current}
  <footer
    data-fx-player
    class="fixed inset-x-0 bottom-0 z-40 isolate overflow-hidden border-t border-black bg-white pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] shadow-[0_-4px_0_rgba(0,0,0,.08)] sm:mx-auto sm:mb-[calc(1rem+env(safe-area-inset-bottom))] sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:border sm:p-0"
  >
    <!-- Phones: the scrubber runs along the top edge, clear of the home indicator's swipe area. -->
    <div
      class="absolute top-0 right-[calc(0.75rem+env(safe-area-inset-right))] left-[calc(0.75rem+env(safe-area-inset-left))] z-1 sm:hidden"
    >
      <input
        class="music-range music-seek block w-full"
        style={`--range-progress:${rangeProgress(elapsed, duration)}`}
        type="range"
        min="0"
        max={duration || 0}
        value={elapsed}
        oninput={seek}
        aria-label="Track position"
      />
    </div>

    <div class="relative px-3 pt-8 pb-3 sm:px-4 sm:pt-3">
      <div
        class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:grid-cols-[minmax(0,1fr)_200px_128px] md:gap-0"
      >
        <div class="flex min-w-0 items-center gap-3">
          <div
            class="relative grid size-14 shrink-0 place-items-center overflow-hidden border border-black bg-[#e8e8e2]"
          >
            <svg
              class="size-5 text-fern-accent/80"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              aria-hidden="true"
              ><path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></svg
            >
            {#key `${current.id}:${current.artworkMediaEntryId ?? ''}`}
              <img
                class="absolute inset-0 size-full object-cover"
                src={`/api/media/${current.id}/artwork`}
                alt={current.album ? `${current.album} cover` : ''}
                onerror={(event) => event.currentTarget.remove()}
              />
            {/key}
          </div>
          <div class="min-w-0">
            {#if sourceHref}
              <a
                class="block h-5 truncate text-sm font-semibold leading-5 text-black underline-offset-2 hover:underline"
                href={sourceHref}
                title="Go to playing source">{trackTitle()}</a
              >
            {:else}
              <p class="h-5 truncate text-sm font-semibold leading-5 text-black">{trackTitle()}</p>
            {/if}
            <p class="truncate text-xs leading-4 text-[#6b6b67]">
              {current.artist ?? current.name}{current.album ? ` · ${current.album}` : ''}
            </p>
            <div
              class="mt-1 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[9px] font-semibold tracking-[.1em] text-[#6b6b67]"
            >
              <span>{audioFormat()}</span>
              {#if isHighResolution()}<span class="text-fern-accent">HI-RES</span>{/if}
              {#if current.audioBitDepth}<span>{current.audioBitDepth}-BIT</span>{/if}
              {#if current.audioSampleRate}<span>{formatSampleRate(current.audioSampleRate)}</span>{/if}
              {#if current.audioBitrate}<span>{formatBitrate(current.audioBitrate)}</span>{/if}
              {#if current.audioChannelLayout}<span>{current.audioChannelLayout.toUpperCase()}</span
                >{:else if current.audioChannels}<span>{current.audioChannels} CH</span>{/if}
            </div>
          </div>
        </div>

        <div class="flex items-center gap-1 md:h-14 md:justify-center md:border-l md:border-dotted md:border-black">
          <button
            class={[
              'grid size-10 cursor-pointer place-items-center border-0 bg-transparent text-[10px] font-bold tracking-[.08em] transition hover:bg-[#e8e8e2]',
              onFxPage ? 'text-[#c93600]' : 'text-[#6b6b67] hover:text-black',
            ]}
            onclick={() => (onFxPage ? closeMusicFx() : openMusicFx())}
            aria-label="Visual effect"
            aria-pressed={onFxPage}>FX</button
          >
          <button
            class={[
              'hidden size-10 cursor-pointer place-items-center border-0 bg-transparent transition hover:bg-[#e8e8e2] disabled:cursor-default disabled:opacity-25 sm:grid',
              $musicPlayer.shuffle ? 'text-[#c93600]' : 'text-[#6b6b67]',
            ]}
            disabled={$musicPlayer.queue.length < 2}
            onclick={toggleShuffle}
            aria-label="Shuffle"
            aria-pressed={$musicPlayer.shuffle}
          >
            <svg
              class="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
              ><path d="M16 3h5v5" /><path d="m4 20 5-5" /><path d="m15 9 6-6" /><path d="M4 4l16 16" /><path
                d="M16 20h5v-5"
              /></svg
            >
          </button>
          <button
            class="grid size-10 cursor-pointer place-items-center border-0 bg-transparent text-[#6b6b67] transition hover:bg-[#e8e8e2] hover:text-black disabled:cursor-default disabled:opacity-25"
            disabled={$musicPlayer.index <= 0}
            onclick={previousTrack}
            aria-label="Previous track"
          >
            <svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
              ><path d="M6 5h2v14H6zm3 7 9-7v14z" /></svg
            >
          </button>
          <button
            class="grid size-10 cursor-pointer place-items-center border border-black bg-fern-accent text-black transition-colors hover:bg-fern-accent-hover"
            onclick={toggle}
            aria-label={$musicPlayer.playing ? 'Pause' : 'Play'}
          >
            {#if $musicPlayer.playing}
              <svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
                ><path d="M7 5h4v14H7zm6 0h4v14h-4z" /></svg
              >
            {:else}
              <svg class="ml-0.5 size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
                ><path d="m8 5 11 7-11 7z" /></svg
              >
            {/if}
          </button>
          <button
            class="grid size-10 cursor-pointer place-items-center border-0 bg-transparent text-[#6b6b67] transition hover:bg-[#e8e8e2] hover:text-black disabled:cursor-default disabled:opacity-25"
            disabled={!$musicPlayer.loop && $musicPlayer.index >= $musicPlayer.queue.length - 1}
            onclick={nextTrack}
            aria-label="Next track"
          >
            <svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
              ><path d="m6 5 9 7-9 7zm10 0h2v14h-2z" /></svg
            >
          </button>
        </div>

        <div class="hidden h-14 items-center justify-center gap-2 border-l border-dotted border-black md:flex">
          <svg
            class="size-4 text-[#6b6b67]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            ><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12" /></svg
          >
          <input
            class="music-range w-20"
            style={`--range-progress:${rangeProgress(volume, 1)}`}
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            oninput={setVolume}
            aria-label="Volume"
          />
        </div>
      </div>

      <div class="mt-3 hidden border-t border-dotted border-black pt-2 sm:block">
        <input
          class="music-range music-seek block w-full"
          style={`--range-progress:${rangeProgress(elapsed, duration)}`}
          type="range"
          min="0"
          max={duration || 0}
          value={elapsed}
          oninput={seek}
          aria-label="Track position"
        />
        <div class="mt-0.5 flex justify-between text-[10px] font-medium tabular-nums text-[#6b6b67]">
          <span>{formatTime(elapsed)}</span><span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
    <audio
      bind:this={audio}
      onloadedmetadata={() => {
        restorePosition();
        syncPositionState();
      }}
      onplay={() => {
        setMusicPlaying(true);
        syncPositionState();
      }}
      onseeked={syncPositionState}
      onratechange={syncPositionState}
      onseeking={() => playCounter.interrupt()}
      onpause={() => {
        playCounter.interrupt();
        setMusicPlaying(false);
        rememberMusicPosition(audio?.currentTime ?? elapsed);
        syncPositionState();
      }}
      ontimeupdate={playbackTimeUpdate}
      ondurationchange={() => (duration = audio?.duration ?? 0)}
      onended={nextTrack}
    ></audio>
  </footer>
{/if}
