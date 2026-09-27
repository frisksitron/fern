import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';

/** A check that every listed numeric column is zero or more. NULLs pass, as in any SQL check. */
function nonNegative(...columns: AnyPgColumn[]): SQL {
  return sql.join(
    columns.map((column) => sql`${column} >= 0`),
    sql` and `,
  );
}

const times = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    avatarKey: text('avatar_key').notNull(),
    ...times,
  },
  (t) => [check('profile_name_length', sql`length(trim(${t.name})) between 1 and 50`)],
);

export const mediaRoots = pgTable(
  'media_roots',
  {
    id: uuid('id').primaryKey(),
    path: text('path').notNull(),
    displayName: text('display_name').notNull(),
    mediaType: text('media_type').notNull(),
    displayOrder: integer('display_order').notNull().default(0),
    lastScannedAt: timestamp('last_scanned_at', { withTimezone: true }),
    ...times,
  },
  (t) => [
    unique('media_root_path').on(t.path),
    check('media_root_type', sql`${t.mediaType} in ('video','music')`),
    check('media_root_display_order', nonNegative(t.displayOrder)),
  ],
);

export const mediaEntries = pgTable(
  'media_entries',
  {
    id: uuid('id').primaryKey(),
    mediaRootId: uuid('media_root_id')
      .notNull()
      .references(() => mediaRoots.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => mediaEntries.id),
    relativePath: text('relative_path').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    sortOrder: integer('sort_order'),
    extension: text('extension'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    mtimeMs: bigint('mtime_ms', { mode: 'number' }).notNull(),
    isVideo: boolean('is_video').notNull().default(false),
    isAudio: boolean('is_audio').notNull().default(false),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    container: text('container'),
    title: text('title'),
    artist: text('artist'),
    album: text('album'),
    albumArtist: text('album_artist'),
    trackNumber: integer('track_number'),
    artworkMediaEntryId: uuid('artwork_media_entry_id').references((): AnyPgColumn => mediaEntries.id, {
      onDelete: 'set null',
    }),
    videoCodec: text('video_codec'),
    audioCodecSummary: text('audio_codec_summary'),
    audioBitrate: integer('audio_bitrate'),
    audioSampleRate: integer('audio_sample_rate'),
    audioBitDepth: integer('audio_bit_depth'),
    audioChannels: integer('audio_channels'),
    audioChannelLayout: text('audio_channel_layout'),
    width: integer('width'),
    height: integer('height'),
    probeStatus: text('probe_status').notNull().default('not_required'),
    probeVersion: integer('probe_version').notNull().default(1),
    probeErrorCode: text('probe_error_code'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...times,
  },
  (t) => [
    unique('entry_root_path').on(t.mediaRootId, t.relativePath),
    index('entry_children').on(t.mediaRootId, t.parentId, t.deletedAt),
    index('entry_video').on(t.isVideo, t.deletedAt),
    index('entry_audio').on(t.isAudio, t.deletedAt),
    index('entry_parent').on(t.parentId),
    index('entry_artwork').on(t.artworkMediaEntryId),
    check('entry_kind', sql`${t.kind} in ('directory','file')`),
    check('entry_probe_status', sql`${t.probeStatus} in ('not_required','pending','ok','failed')`),
    // Only files carry media flags, and a file is video (video root) or audio (music root), never both.
    check(
      'entry_media_flags',
      sql`not (${t.isVideo} and ${t.isAudio}) and (${t.kind} = 'file' or not (${t.isVideo} or ${t.isAudio}))`,
    ),
    check(
      'entry_non_negative',
      nonNegative(
        t.sizeBytes,
        t.durationMs,
        t.sortOrder,
        t.trackNumber,
        t.audioBitrate,
        t.audioSampleRate,
        t.audioBitDepth,
        t.audioChannels,
        t.width,
        t.height,
      ),
    ),
  ],
);

export const playlists = pgTable(
  'playlists',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ...times,
  },
  (t) => [
    index('playlist_profile').on(t.profileId, t.createdAt),
    check('playlist_name_length', sql`length(trim(${t.name})) between 1 and 80`),
  ],
);

export const playlistItems = pgTable(
  'playlist_items',
  {
    id: uuid('id').primaryKey(),
    playlistId: uuid('playlist_id')
      .notNull()
      .references(() => playlists.id, { onDelete: 'cascade' }),
    mediaEntryId: uuid('media_entry_id')
      .notNull()
      .references(() => mediaEntries.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('playlist_media').on(t.playlistId, t.mediaEntryId),
    index('playlist_item_order').on(t.playlistId, t.position),
    index('playlist_item_media').on(t.mediaEntryId),
    check('playlist_item_position', nonNegative(t.position)),
  ],
);

export const mediaTracks = pgTable(
  'media_tracks',
  {
    id: uuid('id').primaryKey(),
    mediaEntryId: uuid('media_entry_id')
      .notNull()
      .references(() => mediaEntries.id, { onDelete: 'cascade' }),
    streamIndex: integer('stream_index').notNull(),
    kind: text('kind').notNull(),
    codec: text('codec').notNull(),
    language: text('language'),
    title: text('title'),
    isDefault: boolean('is_default').notNull().default(false),
    isForced: boolean('is_forced').notNull().default(false),
    channels: integer('channels'),
    channelLayout: text('channel_layout'),
    bitrate: integer('bitrate'),
    sampleRate: integer('sample_rate'),
    bitDepth: integer('bit_depth'),
    width: integer('width'),
    height: integer('height'),
  },
  (t) => [
    unique('track_entry_stream').on(t.mediaEntryId, t.streamIndex),
    check('track_kind', sql`${t.kind} in ('video','audio','subtitle')`),
    check(
      'track_non_negative',
      nonNegative(t.streamIndex, t.channels, t.bitrate, t.sampleRate, t.bitDepth, t.width, t.height),
    ),
  ],
);

export const externalSubtitles = pgTable(
  'external_subtitles',
  {
    id: uuid('id').primaryKey(),
    mediaEntryId: uuid('media_entry_id')
      .notNull()
      .references(() => mediaEntries.id, { onDelete: 'cascade' }),
    relativePath: text('relative_path').notNull(),
    name: text('name').notNull(),
    format: text('format').notNull(),
    language: text('language'),
    mtimeMs: bigint('mtime_ms', { mode: 'number' }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...times,
  },
  (t) => [
    unique('subtitle_entry_path').on(t.mediaEntryId, t.relativePath),
    check('subtitle_format', sql`${t.format} in ('srt','vtt')`),
  ],
);

export const playbackProgress = pgTable(
  'playback_progress',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    mediaEntryId: uuid('media_entry_id')
      .notNull()
      .references(() => mediaEntries.id, { onDelete: 'cascade' }),
    positionMs: bigint('position_ms', { mode: 'number' }).notNull(),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    watched: boolean('watched').notNull().default(false),
    lastPlayedAt: timestamp('last_played_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.mediaEntryId] }),
    index('progress_continue').on(t.profileId, t.watched, t.lastPlayedAt),
    index('progress_media').on(t.mediaEntryId),
    check('progress_non_negative', nonNegative(t.positionMs, t.durationMs)),
  ],
);

/** One listen to a song: recorded once the player has played enough of it (see `$lib/music/plays`). */
export const trackPlays = pgTable(
  'track_plays',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    mediaEntryId: uuid('media_entry_id')
      .notNull()
      .references(() => mediaEntries.id, { onDelete: 'cascade' }),
    playedAt: timestamp('played_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('track_play_recent').on(t.profileId, t.playedAt),
    index('track_play_profile_media').on(t.profileId, t.mediaEntryId),
    index('track_play_media').on(t.mediaEntryId),
  ],
);

// Scan states and error stages mirror ScanState in $lib/shared/contracts/scans; tests/db checks they agree.
export const scanRuns = pgTable(
  'scan_runs',
  {
    id: uuid('id').primaryKey(),
    state: text('state').notNull(),
    // The root this scan covers, or null for every root. No foreign key: a scan of a root that is
    // removed before it runs scans nothing, rather than every root.
    rootId: uuid('root_id'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    currentRootId: uuid('current_root_id'),
    currentPath: text('current_path'),
    directoriesSeen: integer('directories_seen').notNull().default(0),
    filesSeen: integer('files_seen').notNull().default(0),
    videosSeen: integer('videos_seen').notNull().default(0),
    audioSeen: integer('audio_seen').notNull().default(0),
    filesProbed: integer('files_probed').notNull().default(0),
    errorsCount: integer('errors_count').notNull().default(0),
    errorSummary: text('error_summary'),
    /** Delivery attempts started so far; more than one means the scan was retried or redelivered. */
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    check('scan_state', sql`${t.state} in ('queued','running','retrying','completed','failed')`),
    check(
      'scan_counts_non_negative',
      nonNegative(t.directoriesSeen, t.filesSeen, t.videosSeen, t.audioSeen, t.filesProbed, t.errorsCount, t.attempts),
    ),
    // One active scan across every process: scans run one at a time.
    uniqueIndex('scan_single_active')
      .on(sql`(true)`)
      .where(sql`${t.state} in ('queued','running','retrying')`),
  ],
);

/**
 * Durable delivery for accepted scans: a lease table polled by the elected scan worker. `scan_runs`
 * stays the source of truth for what users see; these rows only say whether a scan still has to run,
 * when, and which worker holds it. Rows are deleted by retention cleanup; scan history is not.
 */
export const scanJobs = pgTable(
  'scan_jobs',
  {
    /** One job per scan, so offering the same scan twice is a no-op. */
    scanRunId: uuid('scan_run_id')
      .primaryKey()
      .references(() => scanRuns.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('pending'),
    /** Attempts started, including one in progress. */
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text('locked_by'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('scan_job_available')
      .on(t.availableAt)
      .where(sql`${t.state} = 'pending'`),
    index('scan_job_finished')
      .on(t.finishedAt)
      .where(sql`${t.state} in ('completed','failed')`),
    check('scan_job_state', sql`${t.state} in ('pending','running','completed','failed')`),
    check('scan_job_attempts', sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1`),
    // A lease exists exactly while a worker holds the job.
    check(
      'scan_job_lease',
      sql`case when ${t.state} = 'running' then ${t.lockedBy} is not null and ${t.lockedUntil} is not null else ${t.lockedBy} is null and ${t.lockedUntil} is null end`,
    ),
    check('scan_job_finished_at', sql`(${t.state} in ('completed','failed')) = (${t.finishedAt} is not null)`),
  ],
);

export const scanErrors = pgTable(
  'scan_errors',
  {
    id: uuid('id').primaryKey(),
    scanRunId: uuid('scan_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'cascade' }),
    mediaRootId: uuid('media_root_id').references(() => mediaRoots.id, { onDelete: 'set null' }),
    relativePath: text('relative_path'),
    stage: text('stage').notNull(),
    errorCode: text('error_code').notNull(),
    message: text('message').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('scan_error_run').on(t.scanRunId),
    index('scan_error_root').on(t.mediaRootId),
    check('scan_error_stage', sql`${t.stage} in ('walk','probe')`),
  ],
);
