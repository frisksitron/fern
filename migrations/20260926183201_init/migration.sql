CREATE TABLE "external_subtitles" (
	"id" uuid PRIMARY KEY,
	"media_entry_id" uuid NOT NULL,
	"relative_path" text NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"language" text,
	"mtime_ms" bigint NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subtitle_entry_path" UNIQUE("media_entry_id","relative_path"),
	CONSTRAINT "subtitle_format" CHECK ("format" in ('srt','vtt'))
);
--> statement-breakpoint
CREATE TABLE "media_entries" (
	"id" uuid PRIMARY KEY,
	"media_root_id" uuid NOT NULL,
	"parent_id" uuid,
	"relative_path" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"sort_order" integer,
	"extension" text,
	"size_bytes" bigint,
	"mtime_ms" bigint NOT NULL,
	"is_video" boolean DEFAULT false NOT NULL,
	"is_audio" boolean DEFAULT false NOT NULL,
	"duration_ms" bigint,
	"container" text,
	"title" text,
	"artist" text,
	"album" text,
	"album_artist" text,
	"track_number" integer,
	"artwork_media_entry_id" uuid,
	"video_codec" text,
	"audio_codec_summary" text,
	"audio_bitrate" integer,
	"audio_sample_rate" integer,
	"audio_bit_depth" integer,
	"audio_channels" integer,
	"audio_channel_layout" text,
	"width" integer,
	"height" integer,
	"probe_status" text DEFAULT 'not_required' NOT NULL,
	"probe_version" integer DEFAULT 1 NOT NULL,
	"probe_error_code" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_root_path" UNIQUE("media_root_id","relative_path"),
	CONSTRAINT "entry_kind" CHECK ("kind" in ('directory','file')),
	CONSTRAINT "entry_probe_status" CHECK ("probe_status" in ('not_required','pending','ok','failed')),
	CONSTRAINT "entry_media_flags" CHECK (not ("is_video" and "is_audio") and ("kind" = 'file' or not ("is_video" or "is_audio"))),
	CONSTRAINT "entry_non_negative" CHECK ("size_bytes" >= 0 and "duration_ms" >= 0 and "sort_order" >= 0 and "track_number" >= 0 and "audio_bitrate" >= 0 and "audio_sample_rate" >= 0 and "audio_bit_depth" >= 0 and "audio_channels" >= 0 and "width" >= 0 and "height" >= 0)
);
--> statement-breakpoint
CREATE TABLE "media_roots" (
	"id" uuid PRIMARY KEY,
	"path" text NOT NULL CONSTRAINT "media_root_path" UNIQUE,
	"display_name" text NOT NULL,
	"media_type" text NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"last_scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_root_type" CHECK ("media_type" in ('video','music')),
	CONSTRAINT "media_root_display_order" CHECK ("display_order" >= 0)
);
--> statement-breakpoint
CREATE TABLE "media_tracks" (
	"id" uuid PRIMARY KEY,
	"media_entry_id" uuid NOT NULL,
	"stream_index" integer NOT NULL,
	"kind" text NOT NULL,
	"codec" text NOT NULL,
	"language" text,
	"title" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_forced" boolean DEFAULT false NOT NULL,
	"channels" integer,
	"channel_layout" text,
	"bitrate" integer,
	"sample_rate" integer,
	"bit_depth" integer,
	"width" integer,
	"height" integer,
	CONSTRAINT "track_entry_stream" UNIQUE("media_entry_id","stream_index"),
	CONSTRAINT "track_kind" CHECK ("kind" in ('video','audio','subtitle')),
	CONSTRAINT "track_non_negative" CHECK ("stream_index" >= 0 and "channels" >= 0 and "bitrate" >= 0 and "sample_rate" >= 0 and "bit_depth" >= 0 and "width" >= 0 and "height" >= 0)
);
--> statement-breakpoint
CREATE TABLE "playback_progress" (
	"profile_id" uuid,
	"media_entry_id" uuid,
	"position_ms" bigint NOT NULL,
	"duration_ms" bigint,
	"watched" boolean DEFAULT false NOT NULL,
	"last_played_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playback_progress_pkey" PRIMARY KEY("profile_id","media_entry_id"),
	CONSTRAINT "progress_non_negative" CHECK ("position_ms" >= 0 and "duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "playlist_items" (
	"id" uuid PRIMARY KEY,
	"playlist_id" uuid NOT NULL,
	"media_entry_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlist_media" UNIQUE("playlist_id","media_entry_id"),
	CONSTRAINT "playlist_item_position" CHECK ("position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "playlists" (
	"id" uuid PRIMARY KEY,
	"profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playlist_name_length" CHECK (length(trim("name")) between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"avatar_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_name_length" CHECK (length(trim("name")) between 1 and 50)
);
--> statement-breakpoint
CREATE TABLE "scan_errors" (
	"id" uuid PRIMARY KEY,
	"scan_run_id" uuid NOT NULL,
	"media_root_id" uuid,
	"relative_path" text,
	"stage" text NOT NULL,
	"error_code" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scan_error_stage" CHECK ("stage" in ('walk','probe'))
);
--> statement-breakpoint
CREATE TABLE "scan_jobs" (
	"scan_run_id" uuid PRIMARY KEY,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "scan_job_state" CHECK ("state" in ('pending','running','completed','failed')),
	CONSTRAINT "scan_job_attempts" CHECK ("attempts" >= 0 and "max_attempts" >= 1),
	CONSTRAINT "scan_job_lease" CHECK (case when "state" = 'running' then "locked_by" is not null and "locked_until" is not null else "locked_by" is null and "locked_until" is null end),
	CONSTRAINT "scan_job_finished_at" CHECK (("state" in ('completed','failed')) = ("finished_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" uuid PRIMARY KEY,
	"state" text NOT NULL,
	"root_id" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"current_root_id" uuid,
	"current_path" text,
	"directories_seen" integer DEFAULT 0 NOT NULL,
	"files_seen" integer DEFAULT 0 NOT NULL,
	"videos_seen" integer DEFAULT 0 NOT NULL,
	"audio_seen" integer DEFAULT 0 NOT NULL,
	"files_probed" integer DEFAULT 0 NOT NULL,
	"errors_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "scan_state" CHECK ("state" in ('queued','running','retrying','completed','failed')),
	CONSTRAINT "scan_counts_non_negative" CHECK ("directories_seen" >= 0 and "files_seen" >= 0 and "videos_seen" >= 0 and "audio_seen" >= 0 and "files_probed" >= 0 and "errors_count" >= 0 and "attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "entry_children" ON "media_entries" ("media_root_id","parent_id","deleted_at");--> statement-breakpoint
CREATE INDEX "entry_video" ON "media_entries" ("is_video","deleted_at");--> statement-breakpoint
CREATE INDEX "entry_audio" ON "media_entries" ("is_audio","deleted_at");--> statement-breakpoint
CREATE INDEX "entry_parent" ON "media_entries" ("parent_id");--> statement-breakpoint
CREATE INDEX "entry_artwork" ON "media_entries" ("artwork_media_entry_id");--> statement-breakpoint
CREATE INDEX "progress_continue" ON "playback_progress" ("profile_id","watched","last_played_at");--> statement-breakpoint
CREATE INDEX "progress_media" ON "playback_progress" ("media_entry_id");--> statement-breakpoint
CREATE INDEX "playlist_item_order" ON "playlist_items" ("playlist_id","position");--> statement-breakpoint
CREATE INDEX "playlist_item_media" ON "playlist_items" ("media_entry_id");--> statement-breakpoint
CREATE INDEX "playlist_profile" ON "playlists" ("profile_id","created_at");--> statement-breakpoint
CREATE INDEX "scan_error_run" ON "scan_errors" ("scan_run_id");--> statement-breakpoint
CREATE INDEX "scan_error_root" ON "scan_errors" ("media_root_id");--> statement-breakpoint
CREATE INDEX "scan_job_available" ON "scan_jobs" ("available_at") WHERE "state" = 'pending';--> statement-breakpoint
CREATE INDEX "scan_job_finished" ON "scan_jobs" ("finished_at") WHERE "state" in ('completed','failed');--> statement-breakpoint
CREATE UNIQUE INDEX "scan_single_active" ON "scan_runs" ((true)) WHERE "state" in ('queued','running','retrying');--> statement-breakpoint
ALTER TABLE "external_subtitles" ADD CONSTRAINT "external_subtitles_media_entry_id_media_entries_id_fkey" FOREIGN KEY ("media_entry_id") REFERENCES "media_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "media_entries" ADD CONSTRAINT "media_entries_media_root_id_media_roots_id_fkey" FOREIGN KEY ("media_root_id") REFERENCES "media_roots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "media_entries" ADD CONSTRAINT "media_entries_parent_id_media_entries_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "media_entries"("id");--> statement-breakpoint
ALTER TABLE "media_entries" ADD CONSTRAINT "media_entries_artwork_media_entry_id_media_entries_id_fkey" FOREIGN KEY ("artwork_media_entry_id") REFERENCES "media_entries"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "media_tracks" ADD CONSTRAINT "media_tracks_media_entry_id_media_entries_id_fkey" FOREIGN KEY ("media_entry_id") REFERENCES "media_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playback_progress" ADD CONSTRAINT "playback_progress_profile_id_profiles_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playback_progress" ADD CONSTRAINT "playback_progress_media_entry_id_media_entries_id_fkey" FOREIGN KEY ("media_entry_id") REFERENCES "media_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_playlist_id_playlists_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlists"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlist_items" ADD CONSTRAINT "playlist_items_media_entry_id_media_entries_id_fkey" FOREIGN KEY ("media_entry_id") REFERENCES "media_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_profile_id_profiles_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scan_errors" ADD CONSTRAINT "scan_errors_scan_run_id_scan_runs_id_fkey" FOREIGN KEY ("scan_run_id") REFERENCES "scan_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "scan_errors" ADD CONSTRAINT "scan_errors_media_root_id_media_roots_id_fkey" FOREIGN KEY ("media_root_id") REFERENCES "media_roots"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "scan_jobs" ADD CONSTRAINT "scan_jobs_scan_run_id_scan_runs_id_fkey" FOREIGN KEY ("scan_run_id") REFERENCES "scan_runs"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Zero replicates these columns; keep them in step with src/zero/schema.ts (tests/db/migrations.test.ts checks this).
CREATE PUBLICATION fern_data FOR TABLE
  profiles (id, name, avatar_key, created_at, updated_at),
  media_roots (id, path, display_name, media_type, display_order, last_scanned_at),
  media_entries (id, media_root_id, parent_id, name, kind, sort_order, extension, is_video, is_audio, duration_ms, container, audio_codec_summary, audio_bitrate, audio_sample_rate, audio_bit_depth, audio_channels, audio_channel_layout, title, artist, album, album_artist, track_number, artwork_media_entry_id, deleted_at),
  playlists (id, profile_id, name, created_at, updated_at),
  playlist_items (id, playlist_id, media_entry_id, position, created_at),
  playback_progress (profile_id, media_entry_id, position_ms, duration_ms, watched, last_played_at, updated_at);
