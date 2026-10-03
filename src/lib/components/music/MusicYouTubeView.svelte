<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import Button from '$lib/components/Button.svelte';
  import SectionHeading from '$lib/components/SectionHeading.svelte';
  import { playMusic } from '$lib/client/music-player';
  import { dismissYouTubeDownload, retryYouTubeDownload, startYouTubeDownload } from '$lib/client/youtube';
  import {
    loadMediaEntriesByIds,
    watchMediaRoots,
    watchYouTubeDownloads,
    type MediaRoot,
    type YoutubeDownload,
  } from '$lib/client/zero/data';
  import { formatClock } from '$lib/music/chapters';
  import { messageFrom } from '$lib/shared/errors';
  import { youtubeVideoId } from '$lib/shared/youtube';

  let url = $state('');
  let submitting = $state(false);
  let message = $state('');
  let downloads = $state<readonly YoutubeDownload[]>([]);
  let loaded = $state(false);
  let library = $state<MediaRoot | null>(null);
  let validLink = $derived(youtubeVideoId(url) !== null);

  onMount(() => {
    const cleanups = [
      watchYouTubeDownloads((rows, resultType, error) => {
        if (resultType === 'complete' || rows.length) {
          downloads = rows;
          loaded = true;
        }
        if (resultType === 'error') message = error?.message ?? 'Could not load downloads.';
      }),
      watchMediaRoots((roots) => {
        library = roots.find((root) => root.source === 'youtube') ?? null;
      }, 'music'),
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!validLink || submitting) return;
    submitting = true;
    message = '';
    try {
      await startYouTubeDownload(url.trim());
      url = '';
    } catch (error) {
      message = messageFrom(error, 'Could not start the download.');
    } finally {
      submitting = false;
    }
  }

  async function run(action: () => Promise<unknown>, fallback: string) {
    message = '';
    try {
      await action();
    } catch (error) {
      message = messageFrom(error, fallback);
    }
  }

  async function play(download: YoutubeDownload) {
    const [track] = await loadMediaEntriesByIds([download.mediaEntryId!]);
    if (!track) {
      message = 'That song is no longer in the library.';
      return;
    }
    playMusic([track], track, {
      sourceHref: `/music/${track.mediaRootId}${track.parentId ? `/${track.parentId}` : ''}`,
    });
  }

  function percent(download: YoutubeDownload) {
    if (!download.totalBytes || download.downloadedBytes === null) return null;
    return Math.min(100, Math.floor((download.downloadedBytes / download.totalBytes) * 100));
  }

  function megabytes(bytes: number) {
    return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  }

  function status(download: YoutubeDownload) {
    switch (download.state) {
      case 'queued':
        return 'Waiting';
      case 'downloading': {
        const done = percent(download);
        if (done === null) return 'Starting';
        return `Downloading ${done}% of ${megabytes(download.totalBytes!)}`;
      }
      case 'indexing':
        return 'Adding to the library';
      case 'completed':
        return download.mediaEntryId ? 'In the library' : 'Saved';
      default:
        return 'Failed';
    }
  }

  function thumbnail(download: YoutubeDownload) {
    return download.mediaEntryId
      ? `/api/media/${download.mediaEntryId}/artwork`
      : `https://i.ytimg.com/vi/${download.videoId}/mqdefault.jpg`;
  }
</script>

<SectionHeading title="YouTube">
  {#if library}
    <a
      class="inline-flex min-h-6 items-center text-sm font-semibold text-[#065ec9] no-underline hover:underline"
      href={resolve('/music/[root]', { root: library.id })}>Open library</a
    >
  {/if}
</SectionHeading>

<form class="mb-2 flex gap-2" onsubmit={submit}>
  <label class="min-w-0 flex-1">
    <span class="sr-only">YouTube link</span>
    <input
      class="min-h-11 w-full border border-black bg-white px-3 text-black outline-none placeholder:text-[#777772] focus:outline-2 focus:outline-offset-2 focus:outline-black"
      type="url"
      bind:value={url}
      placeholder="Paste a YouTube link"
      enterkeyhint="go"
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
    />
  </label>
  <Button type="submit" disabled={!validLink || submitting}>Download</Button>
</form>
<p class="mb-6 text-sm text-[#6b6b67]">
  Fern saves the audio to its YouTube library, with the video's chapters, such as the songs of a mix.
</p>

{#if message}
  <p class="mb-5 border border-[#b42318] bg-[#fff0ed] px-4 py-3 text-sm text-[#b42318]" role="alert">{message}</p>
{/if}

{#if downloads.length}
  <ul class="grid gap-3" aria-label="Downloads">
    {#each downloads as download (download.id)}
      {@const done = percent(download)}
      <li
        class="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-start gap-3 sm:grid-cols-[4.5rem_minmax(0,1fr)_auto] border border-black bg-white p-2"
      >
        <div class="relative aspect-square overflow-hidden border border-black bg-[#e8e8e2]">
          {#key thumbnail(download)}
            <img
              class="absolute inset-0 size-full object-cover"
              src={thumbnail(download)}
              alt=""
              loading="lazy"
              onerror={(event) => event.currentTarget.remove()}
            />
          {/key}
        </div>
        <div class="min-w-0 py-0.5">
          <a
            class="block truncate text-sm font-semibold text-black underline-offset-2 hover:underline"
            href={download.url}
            target="_blank"
            rel="noreferrer">{download.title ?? download.url}</a
          >
          <p class="truncate text-xs text-[#6b6b67]">
            {download.channel ?? 'YouTube'}{download.durationMs ? ` · ${formatClock(download.durationMs / 1000)}` : ''}
          </p>
          <p class={['mt-1 text-xs font-semibold', download.state === 'failed' ? 'text-[#b42318]' : 'text-[#414141]']}>
            {download.state === 'failed' ? (download.errorMessage ?? 'Failed') : status(download)}
          </p>
          {#if download.state === 'downloading' || download.state === 'queued' || download.state === 'indexing'}
            <div
              class="mt-2 h-[5px] overflow-hidden rounded-full bg-[#d7d7d1]"
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={download.state === 'indexing' ? 100 : (done ?? 0)}
            >
              <div
                class="h-full bg-[#ff5a1f] transition-[width] duration-700"
                style={`width:${download.state === 'indexing' ? 100 : (done ?? 0)}%`}
              ></div>
            </div>
          {/if}
        </div>
        <div class="flex items-center gap-1">
          {#if download.state === 'completed' && download.mediaEntryId}
            <Button size="small" onclick={() => play(download)}>Play</Button>
          {:else if download.state === 'failed'}
            <Button
              size="small"
              variant="secondary"
              onclick={() => run(() => retryYouTubeDownload(download.id), 'Could not retry the download.')}
              >Retry</Button
            >
          {/if}
          <button
            class="grid size-9 cursor-pointer place-items-center border-0 bg-transparent text-[#6b6b67] hover:bg-[#e8e8e2] hover:text-black"
            onclick={() => run(() => dismissYouTubeDownload(download.id), 'Could not remove the download.')}
            aria-label={download.state === 'completed' || download.state === 'failed'
              ? 'Remove from list'
              : 'Cancel download'}
            title={download.state === 'completed' || download.state === 'failed'
              ? 'Remove from list (the song stays in the library)'
              : 'Cancel download'}>✕</button
          >
        </div>
      </li>
    {/each}
  </ul>
{:else if loaded}
  <p class="border border-black bg-white px-6 py-12 text-center text-sm text-[#6b6b67]">
    Downloads show up here. Long DJ sets and mixes keep their chapters, so you can skip between their songs.
  </p>
{/if}
