<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { currentMusicTrackId, isMusicPlaying, toggleMusicPlayback } from '$lib/client/music-player';
  import type { MediaEntry } from '$lib/client/zero/data';
  import { getPlaylistActions, type MenuItem } from '$lib/components/music/playlist-actions.svelte';
  import { selectTrack, selectedInOrder, type SelectGesture, type Selection } from '$lib/music/track-selection';
  import { formatDuration, formatTotalDuration, trackFolderHref, trackTitle } from '$lib/music/tracks';

  /**
   * Every list of songs in Fern: folder tracks, search results, and playlists behave the same.
   *
   * - Click selects, Ctrl/Cmd-click toggles, Shift-click selects a range; Escape clears.
   * - Double-click, Enter, or the ▶ that replaces the number on hover plays from that song. On touch,
   *   a tap plays, unless songs are selected: then taps select.
   * - Each row's ⋯ menu (also right-click, Shift+F10, or the Menu key) holds the song's actions, and
   *   acts on the whole selection when the row is part of it. Nothing above the list changes with the
   *   selection, so clicking never moves or flashes anything but the rows.
   * - Rows drag onto playlists in the sidebar. In playlists, the handle reorders (Alt+↑/↓ from the
   *   keyboard).
   */
  let {
    tracks,
    source,
    label,
    onPlay,
    onRemove,
    onReorder,
  }: {
    tracks: readonly MediaEntry[];
    /** Where the songs come from: decides whether "Show in folder" makes sense. */
    source: 'folder' | 'search' | 'playlist';
    /** The list's accessible name. */
    label: string;
    onPlay: (track: MediaEntry) => void;
    /** Removes songs from the list (playlists). */
    onRemove?: (tracks: MediaEntry[]) => void;
    /** Receives every song ID in a new order (playlists). */
    onReorder?: (trackIds: string[]) => void;
  } = $props();

  const actions = getPlaylistActions();
  let root: HTMLElement;
  let list: HTMLElement;
  let focusId = $state<string | null>(null);
  let announcement = $state('');

  /** The order while a song is being moved by its handle; the list shows `tracks` otherwise. */
  let dragOrder = $state<string[] | null>(null);
  let draggingId = $state<string | null>(null);
  let dragPointerId: number | null = null;
  let pointerY = 0;
  let scrollFrame = 0;

  let tracksById = $derived(new Map(tracks.map((track) => [track.id, track])));
  let rows = $derived(
    dragOrder ? dragOrder.map((id) => tracksById.get(id)).filter((track): track is MediaEntry => !!track) : tracks,
  );
  let order = $derived(tracks.map((track) => track.id));
  let selectedIds = $derived(selectedInOrder(actions.selection, order));
  let selectedTracks = $derived(selectedIds.map((id) => tracksById.get(id)!));
  let tabStopId = $derived(focusId && tracksById.has(focusId) ? focusId : (tracks[0]?.id ?? null));
  /** Albums are named only when the list mixes them; a folder usually is one album. */
  let showAlbum = $derived(new Set(tracks.map((track) => track.album)).size > 1);
  let totalMs = $derived(tracks.reduce((total, track) => total + (track.durationMs ?? 0), 0));

  const coarsePointer = () => matchMedia('(pointer: coarse)').matches;
  const isSelected = (track: MediaEntry) => selectedIds.includes(track.id);

  function select(track: MediaEntry, gesture: SelectGesture = {}) {
    actions.selection = selectTrack(actions.selection, order, track.id, gesture);
  }

  /** The songs an action on `track` applies to: the selection when the row is part of it. */
  function targetsOf(track: MediaEntry) {
    return isSelected(track) && selectedTracks.length > 1 ? selectedTracks : [track];
  }

  function addToPlaylist(targets: readonly MediaEntry[]) {
    actions.addingTracks = targets;
  }

  function remove(targets: MediaEntry[]) {
    onRemove?.(targets);
    actions.clearSelection();
  }

  function menuItems(track: MediaEntry): MenuItem[] {
    const targets = targetsOf(track);
    const count = targets.length > 1 ? `${targets.length} songs` : null;
    const items: MenuItem[] = [
      { label: count ? `Add ${count} to playlist…` : 'Add to playlist…', run: () => addToPlaylist(targets) },
    ];
    if (onRemove)
      items.push({
        label: count ? `Remove ${count} from playlist` : 'Remove from playlist',
        danger: true,
        run: () => remove(targets),
      });
    if (source !== 'folder' && !count) items.push({ label: 'Show in folder', href: trackFolderHref(track) });
    if (coarsePointer())
      items.push({
        label: isSelected(track) ? 'Deselect' : 'Select',
        run: () => select(track, { toggle: true }),
      });
    if (selectedIds.length > 1) items.push({ label: 'Clear selection', run: () => actions.clearSelection() });
    return items;
  }

  function openMenu(track: MediaEntry, at: { x: number; y: number }, trigger: HTMLElement | null) {
    actions.openMenu(at, menuItems(track), trigger);
  }

  function openMenuFromButton(event: MouseEvent, track: MediaEntry) {
    event.stopPropagation();
    const button = event.currentTarget as HTMLElement;
    const box = button.getBoundingClientRect();
    openMenu(track, { x: box.right - 224, y: box.bottom + 4 }, button);
  }

  function openMenuFromRow(event: MouseEvent, track: MediaEntry) {
    event.preventDefault();
    if (!isSelected(track)) select(track);
    openMenu(track, { x: event.clientX, y: event.clientY }, event.currentTarget as HTMLElement);
  }

  /**
   * The selection before the latest single click. A double-click arrives as two clicks first; playing
   * puts this back, so a double-click plays without selecting.
   */
  let selectionBeforeClick: Selection | null = null;

  function rowClick(event: MouseEvent, track: MediaEntry) {
    if ((event.target as Element).closest('button, a')) return;
    if (coarsePointer()) {
      if (selectedIds.length) select(track, { toggle: true });
      else onPlay(track);
      return;
    }
    // The second click of a double-click does not select either.
    if (event.detail > 1) return;
    selectionBeforeClick = actions.selection;
    select(track, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey });
  }

  function rowDoubleClick(event: MouseEvent, track: MediaEntry) {
    if ((event.target as Element).closest('button, a') || coarsePointer()) return;
    if (selectionBeforeClick) actions.selection = selectionBeforeClick;
    selectionBeforeClick = null;
    onPlay(track);
  }

  /** The number cell's button: plays a track, or pauses and resumes the one that is playing. */
  function playOrToggle(track: MediaEntry) {
    if (track.id === $currentMusicTrackId) toggleMusicPlayback();
    else onPlay(track);
  }

  /**
   * Clicking elsewhere in the page's content, or Escape outside a menu or dialog, clears the
   * selection. The header, sidebar, player, menus, and dialogs are outside the content, so using
   * them keeps it.
   */
  function clearOnOutsidePointer(event: PointerEvent) {
    const target = event.target as Element;
    if (!selectedIds.length || root.contains(target) || !target.closest('main')) return;
    actions.clearSelection();
  }

  function clearOnEscape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !selectedIds.length || actions.menu || actions.addingTracks) return;
    if ((event.target as Element).closest?.('[role="dialog"]')) return;
    actions.clearSelection();
  }

  async function focusRow(id: string) {
    focusId = id;
    await tick();
    list.querySelector<HTMLElement>(`[data-track-id="${id}"]`)?.focus();
  }

  function rowKeydown(event: KeyboardEvent, track: MediaEntry) {
    if (event.target !== event.currentTarget) return;
    const index = order.indexOf(track.id);
    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (step && event.altKey && onReorder) {
      event.preventDefault();
      void moveBy(track, step);
    } else if (step || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = order[event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 : index + step];
      if (!next) return;
      if (event.shiftKey) actions.selection = selectTrack(actions.selection, order, next, { range: true });
      void focusRow(next);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onPlay(track);
    } else if (event.key === ' ') {
      event.preventDefault();
      select(track, { toggle: true });
    } else if (event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      actions.selection = { ids: order, anchor: track.id };
    } else if (event.key === 'Escape' && selectedIds.length) {
      event.preventDefault();
      actions.clearSelection();
    } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const row = event.currentTarget as HTMLElement;
      const box = row.getBoundingClientRect();
      openMenu(track, { x: box.right - 224, y: box.bottom }, row);
    }
  }

  function dragToPlaylist(event: DragEvent, track: MediaEntry) {
    if (draggingId) {
      event.preventDefault();
      return;
    }
    if (!isSelected(track)) select(track);
    actions.beginTrackDrag(event, targetsOf(track));
  }

  // Reordering (playlists) ----------------------------------------------------------------------

  function moved(ids: readonly string[], trackId: string, to: number) {
    const next = ids.filter((id) => id !== trackId);
    next.splice(to, 0, trackId);
    return next;
  }

  function announceMove(trackId: string, ids: readonly string[]) {
    const track = tracksById.get(trackId);
    if (track) announcement = `${trackTitle(track)} moved to position ${ids.indexOf(trackId) + 1} of ${ids.length}.`;
  }

  async function moveBy(track: MediaEntry, step: number) {
    const to = order.indexOf(track.id) + step;
    if (to < 0 || to >= order.length) return;
    const next = moved(order, track.id, to);
    onReorder?.(next);
    announceMove(track.id, next);
    await focusRow(track.id);
  }

  /** Row positions before a move, so moved rows can slide from where they were. */
  function rowPositions() {
    return new Map(
      [...list.querySelectorAll<HTMLElement>('[data-track-id]')].map((row) => [
        row.dataset.trackId!,
        row.getBoundingClientRect().top,
      ]),
    );
  }

  function slideFrom(before: Map<string, number>) {
    for (const row of list.querySelectorAll<HTMLElement>('[data-track-id]')) {
      const offset = (before.get(row.dataset.trackId!) ?? 0) - row.getBoundingClientRect().top;
      if (offset && row.dataset.trackId !== draggingId)
        row.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], {
          duration: 180,
          easing: 'cubic-bezier(.2,.8,.2,1)',
        });
    }
  }

  /**
   * Follows a handle drag on the window rather than on the handle: the dragged row moves in the DOM
   * as it passes other rows, which drops any pointer capture, and the pointer may be released anywhere.
   */
  const moveListeners = [
    ['pointermove', (event: Event) => continueMove(event as PointerEvent)],
    ['pointerup', (event: Event) => finishMove(event as PointerEvent)],
    ['pointercancel', (event: Event) => (event as PointerEvent).pointerId === dragPointerId && endMove()],
    ['keydown', (event: Event) => (event as KeyboardEvent).key === 'Escape' && endMove()],
    ['blur', () => endMove()],
  ] as const;

  function startMove(event: PointerEvent, track: MediaEntry) {
    if (event.button !== 0 || draggingId) return;
    // Keeps the row's own drag (onto playlists) and text selection from starting.
    event.preventDefault();
    dragPointerId = event.pointerId;
    draggingId = track.id;
    dragOrder = [...order];
    pointerY = event.clientY;
    for (const [type, listener] of moveListeners) window.addEventListener(type, listener);
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  /** Ends a move without changing the order: Escape, a cancelled pointer, or leaving the window. */
  function endMove() {
    for (const [type, listener] of moveListeners) window.removeEventListener(type, listener);
    cancelAnimationFrame(scrollFrame);
    dragPointerId = null;
    draggingId = null;
    dragOrder = null;
  }

  onMount(() => endMove);

  /**
   * The moving song's place for a pointer height: after every other row whose middle is above it.
   * Only the height counts, so the move follows the pointer beside, above, or below the list. Layout
   * offsets are used rather than on-screen boxes, which move while rows slide.
   */
  function placeAt(y: number) {
    const listTop = list.getBoundingClientRect().top + list.clientTop;
    let place = 0;
    for (const row of list.querySelectorAll<HTMLElement>('[data-track-id]')) {
      if (row.dataset.trackId !== draggingId && listTop + row.offsetTop + row.offsetHeight / 2 < y) place++;
    }
    return place;
  }

  async function follow() {
    if (!draggingId || !dragOrder) return;
    const place = placeAt(pointerY);
    if (dragOrder.indexOf(draggingId) === place) return;
    const before = rowPositions();
    dragOrder = moved(dragOrder, draggingId, place);
    await tick();
    slideFrom(before);
  }

  /** Scrolls while the pointer rests near the top or bottom edge, so long playlists can be crossed. */
  function autoScroll() {
    if (!draggingId) return;
    const direction = pointerY < 80 ? -1 : pointerY > window.innerHeight - 160 ? 1 : 0;
    if (direction) {
      window.scrollBy(0, direction * 12);
      void follow();
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  function continueMove(event: PointerEvent) {
    if (event.pointerId !== dragPointerId) return;
    pointerY = event.clientY;
    void follow();
  }

  function finishMove(event: PointerEvent) {
    if (event.pointerId !== dragPointerId || !draggingId || !dragOrder) return;
    const next = dragOrder;
    const trackId = draggingId;
    if (next.some((id, index) => id !== order[index])) {
      onReorder?.(next);
      announceMove(trackId, next);
    }
    endMove();
  }
</script>

<svelte:window onpointerdown={clearOnOutsidePointer} onkeydown={clearOnEscape} />

<div class="border border-black bg-white" bind:this={root}>
  <!-- Facts about the list only: selecting never changes it. Actions live in each song's menu. -->
  <div
    class="flex h-11 items-center gap-4 overflow-hidden border-b border-black bg-white px-3 text-sm whitespace-nowrap"
  >
    <span class="text-[#6b6b67]"
      >{tracks.length}
      {tracks.length === 1 ? 'song' : 'songs'}{totalMs ? ` · ${formatTotalDuration(totalMs)}` : ''}</span
    >
  </div>
  <p class="sr-only" aria-live="polite">{selectedIds.length > 1 ? `${selectedIds.length} songs selected` : ''}</p>

  <div class="relative" role="grid" aria-label={label} aria-multiselectable="true" bind:this={list}>
    {#each rows as track, index (track.id)}
      {@const current = track.id === $currentMusicTrackId}
      {@const selected = isSelected(track)}
      <div
        role="row"
        tabindex={track.id === tabStopId ? 0 : -1}
        aria-selected={selected}
        aria-current={current ? 'true' : undefined}
        aria-label={trackTitle(track)}
        data-track-id={track.id}
        class={[
          'group relative grid cursor-default items-center gap-3 border-b border-dotted border-black py-2 pr-1 select-none last:border-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-black',
          onReorder ? 'grid-cols-[24px_32px_1fr_auto_40px] pl-1' : 'grid-cols-[32px_1fr_auto_40px] pl-3',
          selected ? 'bg-[#fff1e8]' : 'hover:bg-[#eeeee8]',
          draggingId === track.id && 'z-1 bg-[#fff1e8] shadow-[inset_0_0_0_2px_#000]',
        ]}
        draggable="true"
        onclick={(event) => rowClick(event, track)}
        ondblclick={(event) => rowDoubleClick(event, track)}
        oncontextmenu={(event) => openMenuFromRow(event, track)}
        onkeydown={(event) => rowKeydown(event, track)}
        onfocus={() => (focusId = track.id)}
        ondragstart={(event) => dragToPlaylist(event, track)}
        ondragend={() => actions.endDrag()}
      >
        {#if onReorder}
          <div role="gridcell">
            <button
              class={[
                'grid h-10 w-6 touch-none place-items-center border-0 bg-transparent p-0 text-[#9b9b95] hover:text-black',
                draggingId === track.id ? 'cursor-grabbing text-black' : 'cursor-grab',
              ]}
              tabindex="-1"
              aria-label={`Move ${trackTitle(track)}`}
              title="Drag to reorder (Alt+↑/↓ from the keyboard)"
              onpointerdown={(event) => startMove(event, track)}
            >
              <svg class="size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                {#each [3.5, 8, 12.5] as y (y)}<circle cx="5.5" cy={y} r="1.25" /><circle
                    cx="10.5"
                    cy={y}
                    r="1.25"
                  />{/each}
              </svg>
            </button>
          </div>
        {/if}
        <div role="gridcell">
          <button
            class={[
              'grid size-8 cursor-pointer place-items-center border-0 bg-transparent p-0 text-xs',
              current ? 'text-fern-accent' : 'text-[#6b6b67] hover:text-black',
            ]}
            tabindex="-1"
            aria-label={current ? ($isMusicPlaying ? 'Pause' : 'Resume') : `Play ${trackTitle(track)}`}
            onclick={() => playOrToggle(track)}
          >
            {#if current && $isMusicPlaying}
              <span class="playing-indicator playing pointer-fine:group-hover:hidden" aria-hidden="true"
                ><i></i><i></i><i></i></span
              >
              <svg
                class="hidden size-3.5 pointer-fine:group-hover:block"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" /></svg
              >
            {:else}
              <span class="pointer-fine:group-hover:hidden">{index + 1}</span>
              <svg
                class="hidden size-3.5 pointer-fine:group-hover:block"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"><path d="M7 4.5v15l12.5-7.5L7 4.5Z" /></svg
              >
            {/if}
          </button>
        </div>
        <div class="min-w-0" role="gridcell">
          <p class={['truncate text-sm font-medium', current && 'text-[#c93600]']}>{trackTitle(track)}</p>
          <p class="truncate text-xs text-[#6b6b67]">
            {track.artist ?? track.name}{showAlbum && track.album ? ` · ${track.album}` : ''}
          </p>
        </div>
        <div class="text-xs text-[#6b6b67] tabular-nums" role="gridcell">{formatDuration(track.durationMs)}</div>
        <div role="gridcell">
          <button
            class="grid size-10 cursor-pointer place-items-center border-0 bg-transparent p-0 text-lg leading-none text-[#414141] hover:text-black focus-visible:opacity-100 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-within:opacity-100"
            tabindex={track.id === tabStopId ? 0 : -1}
            aria-label={`More actions for ${trackTitle(track)}`}
            aria-haspopup="menu"
            onclick={(event) => openMenuFromButton(event, track)}>⋯</button
          >
        </div>
      </div>
    {/each}
  </div>
</div>
{#if onReorder}<p class="sr-only" aria-live="polite">{announcement}</p>{/if}
