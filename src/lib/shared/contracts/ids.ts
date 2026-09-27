import { Schema } from 'effect';

// Branded identifiers keep otherwise indistinguishable strings from being mixed up. Decode them
// at trust boundaries; values read from Fern's own database are trusted and cast, not re-decoded.

const Uuid = Schema.String.check(Schema.isUUID());

export const MediaEntryId = Uuid.pipe(Schema.brand('MediaEntryId'));
export type MediaEntryId = typeof MediaEntryId.Type;

export const MediaRootId = Uuid.pipe(Schema.brand('MediaRootId'));
export type MediaRootId = typeof MediaRootId.Type;

export const ProfileId = Uuid.pipe(Schema.brand('ProfileId'));
export type ProfileId = typeof ProfileId.Type;

export const PlaylistId = Uuid.pipe(Schema.brand('PlaylistId'));
export type PlaylistId = typeof PlaylistId.Type;

export const PlaylistItemId = Uuid.pipe(Schema.brand('PlaylistItemId'));
export type PlaylistItemId = typeof PlaylistItemId.Type;

export const TrackPlayId = Uuid.pipe(Schema.brand('TrackPlayId'));
export type TrackPlayId = typeof TrackPlayId.Type;

export const ScanId = Uuid.pipe(Schema.brand('ScanId'));
export type ScanId = typeof ScanId.Type;

/** An external subtitle file (`external_subtitles.id`). Embedded subtitles use stream indexes. */
export const SubtitleId = Uuid.pipe(Schema.brand('SubtitleId'));
export type SubtitleId = typeof SubtitleId.Type;

/** A SHA-256 cache key naming an HLS session directory. */
export const HlsSessionId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(Schema.brand('HlsSessionId'));
export type HlsSessionId = typeof HlsSessionId.Type;
