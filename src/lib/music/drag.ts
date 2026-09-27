import { Schema } from 'effect';
import { readApiError } from '$lib/shared/contracts/api-error';
import { FolderTracksResponse } from '$lib/shared/contracts/music';

const trackIdsType = 'application/x-fern-track-ids';
const folderType = 'application/x-fern-music-folder';
const playlistNameType = 'application/x-fern-playlist-name';

type DraggedFolder = { readonly rootId: string; readonly folderId: string | null };

function writeCommon(transfer: DataTransfer, label: string, summary: string) {
  transfer.effectAllowed = 'copy';
  transfer.setData(playlistNameType, label);
  transfer.setData('text/plain', summary);
}

export function writeTrackDrag(transfer: DataTransfer, ids: readonly string[], label: string) {
  transfer.setData(trackIdsType, JSON.stringify(ids));
  writeCommon(transfer, label, `${ids.length} ${ids.length === 1 ? 'track' : 'tracks'}`);
}

/** A dragged folder carries only its location; its tracks are looked up when it is dropped. */
export function writeFolderDrag(transfer: DataTransfer, folder: DraggedFolder, label: string) {
  transfer.setData(folderType, JSON.stringify(folder));
  writeCommon(transfer, label, label);
}

function readTrackIds(transfer: DataTransfer | null) {
  try {
    const parsed: unknown = JSON.parse(transfer?.getData(trackIdsType) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

function readDraggedFolder(transfer: DataTransfer | null): DraggedFolder | null {
  try {
    const parsed = JSON.parse(transfer?.getData(folderType) || 'null') as Partial<DraggedFolder> | null;
    if (typeof parsed?.rootId !== 'string') return null;
    return { rootId: parsed.rootId, folderId: typeof parsed.folderId === 'string' ? parsed.folderId : null };
  } catch {
    return null;
  }
}

/** The tracks in a dragged folder and its subfolders, from the server. */
async function fetchFolderTrackIds(folder: DraggedFolder): Promise<string[]> {
  const params = new URLSearchParams({ root: folder.rootId });
  if (folder.folderId) params.set('folder', folder.folderId);
  const response = await fetch(`/api/music/tracks?${params}`);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(readApiError(body)?.message ?? 'Could not read that folder.');
  return [...Schema.decodeUnknownSync(FolderTracksResponse)(body).ids];
}

/** The dragged track IDs, looking up a dragged folder's tracks. */
export async function resolveDraggedTrackIds(transfer: DataTransfer | null) {
  const folder = readDraggedFolder(transfer);
  return folder ? fetchFolderTrackIds(folder) : readTrackIds(transfer);
}

export function readPlaylistName(transfer: DataTransfer | null) {
  return transfer?.getData(playlistNameType) ?? '';
}
