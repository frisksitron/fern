import { Option, Schema } from 'effect';
import { requestJson } from '$lib/client/api';
import { FolderTracksResponse } from '$lib/shared/contracts/music';

const trackIdsType = 'application/x-fern-track-ids';
const folderType = 'application/x-fern-music-folder';
const playlistNameType = 'application/x-fern-playlist-name';

const DraggedFolder = Schema.Struct({ rootId: Schema.String, folderId: Schema.NullOr(Schema.String) });
type DraggedFolder = typeof DraggedFolder.Type;

// Drag data can come from another tab or an older Fern, so it is decoded rather than trusted.
const decodeTrackIds = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeDraggedFolder = Schema.decodeUnknownOption(Schema.fromJsonString(DraggedFolder));

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
  return Option.getOrElse(decodeTrackIds(transfer?.getData(trackIdsType)), () => []);
}

function readDraggedFolder(transfer: DataTransfer | null) {
  return Option.getOrNull(decodeDraggedFolder(transfer?.getData(folderType)));
}

/** The tracks in a dragged folder and its subfolders, from the server. */
async function fetchFolderTrackIds(folder: DraggedFolder): Promise<string[]> {
  const params = new URLSearchParams({ root: folder.rootId });
  if (folder.folderId) params.set('folder', folder.folderId);
  const tracks = await requestJson(
    `/api/music/tracks?${params}`,
    {},
    FolderTracksResponse,
    'Could not read that folder.',
  );
  return [...tracks.ids];
}

/** The dragged track IDs, looking up a dragged folder's tracks. */
export async function resolveDraggedTrackIds(transfer: DataTransfer | null) {
  const folder = readDraggedFolder(transfer);
  return folder ? fetchFolderTrackIds(folder) : readTrackIds(transfer);
}

export function readPlaylistName(transfer: DataTransfer | null) {
  return transfer?.getData(playlistNameType) ?? '';
}
