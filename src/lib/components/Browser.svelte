<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { invalidate } from '$app/navigation';
  import { readProfileId } from '$lib/client/profile';
  import Header from './Header.svelte';
  import MediaFolderNavigation from './MediaFolderNavigation.svelte';
  import {
    removePlaybackProgress,
    reorderMedia,
    setPlaybackWatched,
    watchChildren,
    watchContinueWatching,
    watchMediaRoots,
    watchProgressForMedia,
    watchRecentlyWatched,
    type MediaEntry,
    type MediaRoot,
    type PlaybackProgress,
    type SyncError,
    type SyncStatus,
  } from '$lib/client/zero/data';
  import { CONTINUE_WATCHING_DEPENDENCY, type BrowseSnapshot, type ContinueWatching } from '$lib/shared/browse-data';
  import { sortEntries } from '$lib/shared/sorting';
  import Button from './Button.svelte';

  let {
    rootId = null,
    folderId = null,
    initial,
    continueWatching,
  }: {
    rootId?: string | null;
    folderId?: string | null;
    initial: BrowseSnapshot;
    /**
     * The continue-watching row, shown on the video home only: inside a folder its live updates
     * would move the episodes under the pointer, and the tiles show progress themselves.
     */
    continueWatching?: ContinueWatching | null;
  } = $props();
  const snapshot = untrack(() => initial);
  let roots = $state<readonly MediaRoot[]>(snapshot.roots);
  let syncError = $state('');
  let entries = $state<readonly MediaEntry[]>(snapshot.entries);
  let folder = $state<MediaEntry | null>(snapshot.folder);
  let trail = $state<MediaEntry[]>(snapshot.trail);
  /** Progress on the videos in this folder, for their watched and progress markers. */
  let progressByMedia = $state(new Map(snapshot.folderProgress.map((item) => [item.mediaEntryId, item])));
  let hydrated = $state(false);
  let directories = $derived(entries.filter((entry) => entry.kind === 'directory'));
  let mediaEntries = $derived(entries.filter((entry) => entry.kind === 'file'));
  // The continue-watching row comes from the server, which reads only the history it needs.
  let resumable = $derived(continueWatching?.progress ?? []);
  let resumableMedia = $derived(new Map((continueWatching?.entries ?? []).map((entry) => [entry.id, entry])));
  let upNext = $derived(continueWatching?.upNext ?? []);
  let mediaIdsKey = $derived(mediaEntries.map((entry) => entry.id).join(','));
  let profileId = $state('');
  let reorderMode = $state(false);
  let draggingId = $state<string | null>(null);
  let suppressClickId = $state<string | null>(null);
  let pressTimer: number | null = null;
  let activePointerId: number | null = null;
  let orderBeforeDrag: string[] = [];
  let dragGhost: HTMLElement | null = null;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragOverId: string | null = null;

  onMount(() => {
    hydrated = true;
    profileId = readProfileId();
    const reportQueryError = (resultType: SyncStatus, error?: SyncError) => {
      if (resultType === 'error') syncError = error?.message ?? 'Could not synchronize the library.';
    };
    const cleanups = [
      watchMediaRoots((data, resultType, error) => {
        if (resultType === 'complete') roots = data;
        reportQueryError(resultType, error);
      }, 'video'),
    ];

    if (rootId) {
      cleanups.push(
        watchChildren(rootId, folderId, (data, resultType, error) => {
          if (!draggingId && resultType === 'complete') {
            entries = sortEntries(data.filter((entry) => entry.kind === 'directory' || entry.isVideo));
          }
          reportQueryError(resultType, error);
        }),
      );
    }

    if (profileId && continueWatching) {
      // Both queries are bounded; they only tell the page when to reload the continue-watching row.
      const reload = changeSignal(() => invalidate(CONTINUE_WATCHING_DEPENDENCY));
      cleanups.push(
        reload.stop,
        watchContinueWatching(profileId, (data, resultType, error) => {
          reload.observe('resumable', data, resultType);
          reportQueryError(resultType, error);
        }),
        watchRecentlyWatched(profileId, (data, resultType, error) => {
          reload.observe('watched', data, resultType);
          reportQueryError(resultType, error);
        }),
      );
    }

    // Once a long press picks an episode up, the finger moves it instead of scrolling the page.
    const holdScroll = (event: TouchEvent) => {
      if (draggingId && event.cancelable) event.preventDefault();
    };
    window.addEventListener('touchmove', holdScroll, { passive: false });
    cleanups.push(() => window.removeEventListener('touchmove', holdScroll));

    return () => cleanups.forEach((cleanup) => cleanup());
  });

  // Progress for this folder's videos only; resubscribes when the folder's videos change.
  $effect(() => {
    const ids = mediaIdsKey ? mediaIdsKey.split(',') : [];
    if (!profileId || !ids.length) return;
    return watchProgressForMedia(profileId, ids, (data, resultType, error) => {
      if (resultType === 'complete') progressByMedia = new Map(data.map((item) => [item.mediaEntryId, item]));
      if (resultType === 'error') syncError = error?.message ?? 'Could not synchronize playback progress.';
    });
  });

  /**
   * Calls `reload` (debounced) when a watched query's rows change after its first complete result.
   * Each query's first complete result matches what the server already rendered.
   */
  function changeSignal(reload: () => unknown) {
    const seen = new Map<string, string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      observe(name: string, rows: readonly PlaybackProgress[], resultType: SyncStatus) {
        if (resultType !== 'complete') return;
        const key = rows.map((row) => `${row.mediaEntryId}:${row.positionMs}:${row.watched}`).join('|');
        const previous = seen.get(name);
        seen.set(name, key);
        if (previous === undefined || previous === key) return;
        clearTimeout(timer);
        timer = setTimeout(reload, 500);
      },
      stop: () => clearTimeout(timer),
    };
  }

  async function removeFromContinue(mediaEntryId: string) {
    try {
      await removePlaybackProgress(profileId, mediaEntryId);
    } catch (cause) {
      syncError = cause instanceof Error ? cause.message : 'Could not update playback progress.';
    }
  }

  async function setWatched(mediaEntryId: string, watched: boolean) {
    try {
      await setPlaybackWatched(profileId, mediaEntryId, watched);
    } catch (cause) {
      syncError = cause instanceof Error ? cause.message : 'Could not update playback progress.';
    }
  }

  function mediaOrder() {
    return entries.filter((entry) => entry.kind === 'file' && entry.isVideo).map((entry) => entry.id);
  }

  async function persistOrder() {
    const entryIds = mediaOrder();
    const orderById = new Map(entryIds.map((id, index) => [id, index]));
    entries = entries.map((entry) =>
      orderById.has(entry.id) ? { ...entry, sortOrder: orderById.get(entry.id)! } : entry,
    );
    try {
      await reorderMedia(rootId!, folderId, entryIds);
    } catch (cause) {
      syncError = cause instanceof Error ? cause.message : 'Could not save the media order.';
    }
  }

  async function moveDraggedOver(overId: string) {
    if (!draggingId || draggingId === overId) return;
    const positions = new Map(
      Array.from(document.querySelectorAll<HTMLElement>('[data-reorder-id]')).map((element) => [
        element.dataset.reorderId!,
        element.getBoundingClientRect(),
      ]),
    );
    const next = [...entries];
    const from = next.findIndex((entry) => entry.id === draggingId);
    const over = next.findIndex((entry) => entry.id === overId);
    const [moved] = next.splice(from, 1);
    const target = next.findIndex((entry) => entry.id === overId);
    next.splice(from < over ? target + 1 : target, 0, moved);
    entries = next;
    await tick();
    for (const element of document.querySelectorAll<HTMLElement>('[data-reorder-id]')) {
      if (element.dataset.reorderId === draggingId) continue;
      const before = positions.get(element.dataset.reorderId!);
      const after = element.getBoundingClientRect();
      if (!before || (before.left === after.left && before.top === after.top)) continue;
      element.animate(
        [
          { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px)` },
          { transform: 'translate(0, 0)' },
        ],
        { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
    }
  }

  function activateDrag(target: HTMLElement, event: PointerEvent, entryId: string) {
    const rect = target.getBoundingClientRect();
    dragGhost = target.cloneNode(true) as HTMLElement;
    dragGhost.removeAttribute('data-reorder-id');
    dragGhost.setAttribute('data-drag-ghost', '');
    dragGhost.setAttribute('aria-hidden', 'true');
    Object.assign(dragGhost.style, {
      position: 'fixed',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      zIndex: '100',
      pointerEvents: 'none',
      opacity: '.95',
      transform: 'scale(1.04) rotate(1deg)',
      boxShadow: '0 20px 50px #000a, 0 0 0 2px #89b9a7',
      borderRadius: '4px',
    });
    document.body.append(dragGhost);
    dragOffsetX = event.clientX - rect.left;
    dragOffsetY = event.clientY - rect.top;
    reorderMode = true;
    draggingId = entryId;
    suppressClickId = entryId;
    activePointerId = event.pointerId;
    orderBeforeDrag = mediaOrder();
    target.setPointerCapture(event.pointerId);
    navigator.vibrate?.(10);
  }

  function beginReorder(event: PointerEvent, entryId: string) {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    const target = event.currentTarget as HTMLElement;
    pressTimer = window.setTimeout(() => activateDrag(target, event, entryId), 450);
  }

  function continueReorder(event: PointerEvent) {
    if (event.pointerId !== activePointerId || !draggingId || !dragGhost) return;
    event.preventDefault();
    dragGhost.style.left = `${event.clientX - dragOffsetX}px`;
    dragGhost.style.top = `${event.clientY - dragOffsetY}px`;
    const over =
      document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-reorder-id]')?.dataset
        .reorderId ?? null;
    if (!over || over === draggingId) {
      dragOverId = over;
      return;
    }
    if (over !== dragOverId) {
      dragOverId = over;
      void moveDraggedOver(over);
    }
  }

  function cancelPendingReorder() {
    if (pressTimer !== null) window.clearTimeout(pressTimer);
    pressTimer = null;
  }

  function finishReorder(event: PointerEvent) {
    cancelPendingReorder();
    if (event.pointerId !== activePointerId || !draggingId) return;
    const dragged = draggingId;
    dragGhost?.remove();
    dragGhost = null;
    draggingId = null;
    dragOverId = null;
    activePointerId = null;
    reorderMode = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    if (mediaOrder().some((id, index) => id !== orderBeforeDrag[index])) void persistOrder();
    window.setTimeout(() => {
      if (suppressClickId === dragged) suppressClickId = null;
    });
  }

  function mediaName(entry: MediaEntry) {
    return entry.extension && entry.name.toLowerCase().endsWith(entry.extension.toLowerCase())
      ? entry.name.slice(0, -entry.extension.length)
      : entry.name;
  }

  function thumbnailPosition(entry: MediaEntry, playback?: PlaybackProgress) {
    const defaultPosition = Math.round((entry.durationMs ?? 0) * 0.3);
    if (playback?.watched) return defaultPosition;
    return playback?.positionMs || defaultPosition;
  }

  function formatDuration(durationMs: number | null) {
    if (!durationMs) return '';
    const seconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(seconds / 60);
    return minutes >= 60
      ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
      : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }
</script>

<Header />
<main class="mx-auto max-w-[1168px] px-4 pt-6 pb-20 sm:px-6 sm:pt-12 md:px-10" data-hydrated={hydrated}>
  {#if syncError}<p class="mt-4 border border-[#b42318] bg-[#fff0ed] px-4 py-3 text-sm text-[#b42318]" role="alert">
      {syncError}
    </p>{/if}
  {#if resumable.length || upNext.length}
    <section>
      <header class="mb-6 flex min-h-11 items-center justify-between gap-4 border-b border-dotted border-black pb-3">
        <h2 class="text-base font-bold">Continue watching /</h2>
      </header>
      <div
        class="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto overscroll-x-contain px-4 pt-1 pb-6 [scrollbar-width:thin] sm:mx-0 sm:scroll-px-0.5 sm:px-0.5"
      >
        {#each resumable as item}
          {@const media = resumableMedia.get(item.mediaEntryId)!}
          <div class="group relative w-70 shrink-0 snap-start overflow-hidden border border-black bg-white">
            <a class="block overflow-hidden bg-white no-underline" href={`/watch/${media.id}`}>
              <div class="relative aspect-video overflow-hidden">
                <img
                  class="absolute inset-0 size-full object-cover"
                  src={`/api/media/${media.id}/thumbnail?positionMs=${item.positionMs}`}
                  alt=""
                  loading="lazy"
                  onerror={(event) => event.currentTarget.remove()}
                />
                <span class="absolute inset-0 bg-linear-to-t from-black/50 via-black/10 to-transparent"></span>
                <progress
                  class="absolute right-0 bottom-0 left-0 h-1 w-full border-0 accent-fern-accent"
                  value={item.positionMs}
                  max={item.durationMs ?? media.durationMs ?? 1}
                ></progress>
              </div>
              <span class="line-clamp-2 min-h-12 px-4 py-3 font-medium leading-6" title={media.name}
                >{mediaName(media)}</span
              >
            </a>
            <Button
              class="absolute top-2 right-2 opacity-100 sm:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              variant="secondary"
              size="small"
              aria-label={`Remove ${media.name} from Continue Watching`}
              onclick={() => removeFromContinue(media.id)}>Remove</Button
            >
          </div>
        {/each}
        {#each upNext as media}
          <div class="group relative w-70 shrink-0 snap-start overflow-hidden border border-black bg-white">
            <a class="block overflow-hidden bg-white no-underline" href={`/watch/${media.id}`}>
              <div class="relative aspect-video overflow-hidden">
                <img
                  class="absolute inset-0 size-full object-cover"
                  src={`/api/media/${media.id}/thumbnail?positionMs=${thumbnailPosition(media)}`}
                  alt=""
                  loading="lazy"
                  onerror={(event) => event.currentTarget.remove()}
                />
                <span class="absolute inset-0 bg-linear-to-t from-black/50 via-black/10 to-transparent"></span>
                <span
                  class="absolute top-3 left-3 border border-black bg-fern-accent px-2 py-1 text-xs font-bold text-black uppercase"
                  >Up next</span
                >
              </div>
              <span class="line-clamp-2 min-h-12 px-4 py-3 font-medium leading-6" title={media.name}
                >{mediaName(media)}</span
              >
            </a>
          </div>
        {/each}
      </div>
    </section>
  {/if}

  <section class:mt-10={resumable.length || upNext.length}>
    <MediaFolderNavigation
      basePath="/browse"
      rootLabel="Video"
      emptyMessage="No media folders are configured."
      addFolderLabel="Add a media folder"
      addFolderHref="/settings/media/add?type=video"
      {rootId}
      {folderId}
      {roots}
      {folder}
      {trail}
      {directories}
      showRootHeading
    />
    {#if rootId && mediaEntries.length}
      <div class="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(210px,1fr))]">
        {#each mediaEntries as entry (entry.id)}
          {@const playback = progressByMedia.get(entry.id)}
          {@const playbackDuration = playback?.durationMs ?? entry.durationMs ?? 1}
          <div
            class={[
              'group relative min-w-0 select-none [-webkit-touch-callout:none]',
              draggingId === entry.id && 'touch-none opacity-20',
            ]}
            data-reorder-id={entry.id}
            role="group"
            aria-label={reorderMode ? `${mediaName(entry)}, draggable episode` : undefined}
            onpointerdown={(event) => beginReorder(event, entry.id)}
            onpointermove={continueReorder}
            onpointerup={finishReorder}
            onpointercancel={finishReorder}
            onpointerleave={() => {
              if (!draggingId) cancelPendingReorder();
            }}
            ondragstart={(event) => event.preventDefault()}
            oncontextmenu={(event) => event.preventDefault()}
          >
            <a
              class="flex overflow-hidden border border-black bg-white font-medium no-underline hover:bg-[#fff1e8] sm:block"
              href={`/watch/${entry.id}`}
              onclick={(event) => {
                if (reorderMode || suppressClickId === entry.id) event.preventDefault();
              }}
            >
              <!-- Phones list episodes as rows, the thumbnail beside the title; wider screens use a grid of cards. -->
              <div
                class="relative aspect-video w-40 shrink-0 overflow-hidden border-r border-black sm:min-h-29.5 sm:w-auto sm:border-r-0 sm:border-b"
              >
                <img
                  class={[
                    'absolute inset-0 size-full object-cover transition',
                    playback?.watched && 'opacity-50 saturate-50',
                  ]}
                  src={`/api/media/${entry.id}/thumbnail?positionMs=${thumbnailPosition(entry, playback)}`}
                  alt=""
                  loading="lazy"
                  onerror={(event) => event.currentTarget.remove()}
                />
                {#if playback?.watched}<span
                    class="absolute inset-0 bg-fern-accent/40 mix-blend-color"
                    data-watched-tint
                  ></span>{/if}
                <span class="absolute inset-0 bg-linear-to-t from-black/50 via-black/5 to-transparent"></span>
                <span
                  class="absolute top-1/2 left-1/2 hidden size-10 -translate-x-1/2 -translate-y-1/2 place-items-center border border-black bg-fern-accent pl-0.5 text-sm text-black sm:grid"
                  >▶</span
                >
                {#if entry.durationMs}<span
                    class="absolute top-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-xs font-medium text-zinc-200 backdrop-blur"
                    >{formatDuration(entry.durationMs)}</span
                  >{/if}
                {#if playback && (playback.positionMs > 0 || playback.watched)}<progress
                    class="absolute right-0 bottom-0 left-0 h-1 w-full border-0 accent-fern-accent"
                    value={playback.watched && playback.positionMs === 0 ? playbackDuration : playback.positionMs}
                    max={playbackDuration}
                  ></progress>{/if}
              </div>
              <span
                class="flex min-w-0 flex-1 items-center px-3 py-2 leading-5 sm:block sm:min-h-14 sm:px-4"
                title={entry.name}><span class="line-clamp-3 sm:line-clamp-2">{mediaName(entry)}</span></span
              >
            </a>
            {#if !reorderMode}
              <button
                class={[
                  'absolute top-1.5 left-1.5 z-2 grid size-10 cursor-pointer place-items-center border border-black text-xs font-medium sm:top-2 sm:left-2 sm:size-auto sm:min-h-10 sm:px-2',
                  playback?.watched
                    ? 'bg-fern-accent text-black opacity-100 hover:bg-fern-accent-hover'
                    : 'bg-white/85 text-black opacity-100 hover:bg-[#e8e8e2] sm:bg-white sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100',
                ]}
                aria-label={playback?.watched
                  ? `Mark ${mediaName(entry)} as unwatched`
                  : `Mark ${mediaName(entry)} as watched`}
                onclick={() => setWatched(entry.id, !playback?.watched)}
                ><span class="sm:hidden" aria-hidden="true">✓</span><span class="max-sm:hidden"
                  >{playback?.watched ? 'Watched' : 'Mark watched'}</span
                ></button
              >
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>
</main>
