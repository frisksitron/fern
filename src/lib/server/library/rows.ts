import { mediaEntries, playbackProgress, playlistItems, playlists } from '$lib/server/db/schema';
import type { MediaEntry, PlaybackProgress, Playlist, PlaylistItem } from '$lib/zero/schema';

// Page loads send rows in the same shape Zero synchronizes (timestamps as epoch milliseconds), so a
// page can render server data first and then follow Zero's live rows without converting.

/** The `media_entries` columns Zero synchronizes. */
export const mediaEntryColumns = {
  id: mediaEntries.id,
  mediaRootId: mediaEntries.mediaRootId,
  parentId: mediaEntries.parentId,
  name: mediaEntries.name,
  kind: mediaEntries.kind,
  sortOrder: mediaEntries.sortOrder,
  extension: mediaEntries.extension,
  isVideo: mediaEntries.isVideo,
  isAudio: mediaEntries.isAudio,
  durationMs: mediaEntries.durationMs,
  container: mediaEntries.container,
  audioCodecSummary: mediaEntries.audioCodecSummary,
  audioBitrate: mediaEntries.audioBitrate,
  audioSampleRate: mediaEntries.audioSampleRate,
  audioBitDepth: mediaEntries.audioBitDepth,
  audioChannels: mediaEntries.audioChannels,
  audioChannelLayout: mediaEntries.audioChannelLayout,
  title: mediaEntries.title,
  artist: mediaEntries.artist,
  album: mediaEntries.album,
  albumArtist: mediaEntries.albumArtist,
  trackNumber: mediaEntries.trackNumber,
  artworkMediaEntryId: mediaEntries.artworkMediaEntryId,
  deletedAt: mediaEntries.deletedAt,
};

type MediaEntryRow = { [Key in keyof typeof mediaEntryColumns]: (typeof mediaEntries.$inferSelect)[Key] };

export function toMediaEntry(row: MediaEntryRow): MediaEntry {
  return { ...row, deletedAt: row.deletedAt?.getTime() ?? null };
}

export function toProgress(row: typeof playbackProgress.$inferSelect): PlaybackProgress {
  return {
    profileId: row.profileId,
    mediaEntryId: row.mediaEntryId,
    positionMs: row.positionMs,
    durationMs: row.durationMs,
    watched: row.watched,
    lastPlayedAt: row.lastPlayedAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function toPlaylist(row: typeof playlists.$inferSelect): Playlist {
  return {
    id: row.id,
    profileId: row.profileId,
    name: row.name,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function toPlaylistItem(row: typeof playlistItems.$inferSelect): PlaylistItem {
  return {
    id: row.id,
    playlistId: row.playlistId,
    mediaEntryId: row.mediaEntryId,
    position: row.position,
    createdAt: row.createdAt.getTime(),
  };
}
