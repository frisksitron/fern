import { createContext } from 'svelte';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { askConfirm, askText } from '$lib/client/dialogs.svelte';
import { playMusic } from '$lib/client/music-player';
import { readProfileId } from '$lib/client/profile';
import {
  addTracksToPlaylist,
  createPlaylist,
  deletePlaylist,
  loadMediaEntriesByIds,
  loadPlaylistItems,
  renamePlaylist,
  type MediaEntry,
  type Playlist,
} from '$lib/client/zero/data';
import { readPlaylistName, resolveDraggedTrackIds, writeFolderDrag, writeTrackDrag } from '$lib/music/drag';
import { emptySelection, type Selection } from '$lib/music/track-selection';
import { trackTitle } from '$lib/music/tracks';
import { messageFrom } from '$lib/shared/errors';
import type { BrowseMemory } from './browse-memory.svelte';
import type { MusicCatalog } from './catalog.svelte';

/** One entry of a context menu: a link, or an action. */
export type MenuItem = { readonly label: string; readonly danger?: boolean } & (
  { readonly href: string } | { readonly run: () => unknown }
);

export class PlaylistActions {
  /** The selected tracks of the list on screen (see `$lib/music/track-selection`). */
  selection = $state<Selection>(emptySelection);
  /** Tracks the "Add to playlist" dialog is adding. */
  addingTracks = $state<readonly MediaEntry[] | null>(null);
  dragging = $state(false);
  dropTargetId = $state<string | null>(null);
  /** The open context menu: a track's ⋯ menu or a playlist's menu in the sidebar. */
  menu = $state<{
    readonly x: number;
    readonly y: number;
    readonly items: readonly MenuItem[];
    /** Gets the focus back when the menu closes. */
    readonly trigger: HTMLElement | null;
  } | null>(null);

  constructor(
    private catalog: MusicCatalog,
    private browse: BrowseMemory,
  ) {}

  clearSelection() {
    this.selection = emptySelection;
  }

  async create(trackIds: readonly string[] = [], suggestedName = '') {
    const name = await askText({ title: 'New playlist', label: 'Name', value: suggestedName, confirmLabel: 'Create' });
    if (!name) return;
    try {
      const id = await createPlaylist(readProfileId(), name);
      if (trackIds.length) await addTracksToPlaylist(id, trackIds);
      this.clearSelection();
      this.catalog.message = '';
    } catch (error) {
      this.catalog.message = messageFrom(error, 'Could not create playlist.');
    }
  }

  async addTo(playlistId: string) {
    const tracks = this.addingTracks;
    if (!tracks?.length) return;
    try {
      await addTracksToPlaylist(
        playlistId,
        tracks.map((track) => track.id),
      );
      this.addingTracks = null;
      this.clearSelection();
    } catch (error) {
      this.catalog.message = messageFrom(error, 'Could not add tracks.');
    }
  }

  /** Creates a playlist holding the tracks the "Add to playlist" dialog is adding. */
  async addToNew() {
    const tracks = this.addingTracks ?? [];
    this.addingTracks = null;
    await this.create(tracks.map((track) => track.id));
  }

  /** Drags `tracks` (the selection, or the one track dragged) onto a playlist in the sidebar. */
  beginTrackDrag(event: DragEvent, tracks: readonly MediaEntry[]) {
    this.beginDrag(
      event,
      tracks.map((track) => track.id),
      tracks.length === 1 ? trackTitle(tracks[0]) : 'New playlist',
    );
  }

  beginFolderDrag(event: DragEvent, rootId: string, folderId: string | null, label: string) {
    if (!event.dataTransfer) return;
    this.dragging = true;
    writeFolderDrag(event.dataTransfer, { rootId, folderId }, label);
  }

  dragOver(event: DragEvent, targetId: string) {
    if (!this.dragging || !event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    this.dropTargetId = targetId;
  }

  dragLeave(targetId: string) {
    if (this.dropTargetId === targetId) this.dropTargetId = null;
  }

  async dropOnPlaylist(event: DragEvent, playlist: Playlist) {
    event.preventDefault();
    const transfer = event.dataTransfer;
    this.endDrag();
    try {
      const ids = await resolveDraggedTrackIds(transfer);
      if (!ids.length) {
        this.catalog.message = 'This folder contains no tracks.';
        return;
      }
      await addTracksToPlaylist(playlist.id, ids);
      this.clearSelection();
      this.catalog.message = '';
    } catch (error) {
      this.catalog.message = messageFrom(error, 'Could not add tracks.');
    }
  }

  async dropOnNewPlaylist(event: DragEvent) {
    event.preventDefault();
    const transfer = event.dataTransfer;
    const suggestedName = readPlaylistName(transfer);
    this.endDrag();
    try {
      const ids = await resolveDraggedTrackIds(transfer);
      if (ids.length) await this.create(ids, suggestedName);
      else this.catalog.message = 'This folder contains no tracks.';
    } catch (error) {
      this.catalog.message = messageFrom(error, 'Could not add tracks.');
    }
  }

  endDrag() {
    this.dragging = false;
    this.dropTargetId = null;
  }

  /** Opens a menu at a point, kept inside the window. */
  openMenu(at: { x: number; y: number }, items: readonly MenuItem[], trigger: HTMLElement | null = null) {
    const width = 224;
    const height = items.length * 44 + 10;
    this.menu = {
      x: Math.max(8, Math.min(at.x, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(at.y, window.innerHeight - height - 8)),
      items,
      trigger,
    };
  }

  openPlaylistMenu(event: MouseEvent, playlist: Playlist) {
    event.preventDefault();
    this.openMenu({ x: event.clientX, y: event.clientY }, this.playlistMenuItems(playlist));
  }

  /** The playlist page's ⋯ button: the same menu, below the button. */
  openPlaylistMenuFromButton(event: MouseEvent, playlist: Playlist) {
    event.stopPropagation();
    const button = event.currentTarget as HTMLElement;
    const box = button.getBoundingClientRect();
    this.openMenu({ x: box.right - 224, y: box.bottom + 4 }, this.playlistMenuItems(playlist), button);
  }

  private playlistMenuItems(playlist: Playlist): MenuItem[] {
    return [
      { label: 'Play', run: () => this.play(playlist) },
      { label: 'Rename', run: () => this.rename(playlist) },
      { label: 'Delete playlist', danger: true, run: () => this.remove(playlist) },
    ];
  }

  closeMenu({ restoreFocus = false } = {}) {
    if (restoreFocus) this.menu?.trigger?.focus();
    this.menu = null;
  }

  async play(playlist: Playlist) {
    try {
      const items = await loadPlaylistItems(playlist.id);
      const tracks = await loadMediaEntriesByIds(items.map((item) => item.mediaEntryId));
      const trackById = new Map(tracks.filter((track) => track.isAudio).map((track) => [track.id, track]));
      const queue = items
        .map((item) => trackById.get(item.mediaEntryId))
        .filter((track): track is MediaEntry => Boolean(track));
      if (!queue.length) {
        this.catalog.message = `${playlist.name} is empty.`;
        return;
      }
      playMusic(queue, queue[0], {
        loop: true,
        playlistId: playlist.id,
        sourceHref: `/music/playlist/${playlist.id}`,
      });
    } catch (error) {
      this.catalog.message = messageFrom(error, 'Could not play playlist.');
    }
  }

  async remove(playlist: Playlist) {
    this.closeMenu();
    const confirmed = await askConfirm({
      title: 'Delete playlist',
      message: `Delete “${playlist.name}”? Its tracks stay in your library.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    await deletePlaylist(playlist.id);
    if (page.url.pathname === `/music/playlist/${playlist.id}`) await goto(this.browse.href);
  }

  async rename(playlist: Playlist) {
    this.closeMenu();
    const name = await askText({ title: 'Rename playlist', label: 'Name', value: playlist.name });
    if (!name || name === playlist.name) return;
    try {
      await renamePlaylist(playlist.id, name);
    } catch (error) {
      this.catalog.message = messageFrom(error, 'Could not rename playlist.');
    }
  }

  private beginDrag(event: DragEvent, ids: readonly string[], label: string) {
    if (!ids.length || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    this.dragging = true;
    writeTrackDrag(event.dataTransfer, ids, label);
  }
}

export const [getPlaylistActions, setPlaylistActions] = createContext<PlaylistActions>();
