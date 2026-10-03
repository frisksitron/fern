CREATE TABLE "media_chapters" (
	"media_entry_id" uuid,
	"position" integer,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	"title" text,
	CONSTRAINT "media_chapters_pkey" PRIMARY KEY("media_entry_id","position"),
	CONSTRAINT "chapter_non_negative" CHECK ("position" >= 0 and "start_ms" >= 0),
	CONSTRAINT "chapter_order" CHECK ("end_ms" > "start_ms")
);
--> statement-breakpoint
CREATE TABLE "youtube_downloads" (
	"id" uuid PRIMARY KEY,
	"video_id" text NOT NULL,
	"url" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"title" text,
	"channel" text,
	"duration_ms" bigint,
	"downloaded_bytes" bigint,
	"total_bytes" bigint,
	"relative_path" text,
	"media_entry_id" uuid,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "youtube_download_state" CHECK ("state" in ('queued','downloading','indexing','completed','failed')),
	CONSTRAINT "youtube_download_non_negative" CHECK ("duration_ms" >= 0 and "downloaded_bytes" >= 0 and "total_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "media_roots" ADD COLUMN "source" text DEFAULT 'folder' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_root_single_youtube" ON "media_roots" ("source") WHERE "source" = 'youtube';--> statement-breakpoint
CREATE INDEX "youtube_download_recent" ON "youtube_downloads" ("created_at");--> statement-breakpoint
CREATE INDEX "youtube_download_media" ON "youtube_downloads" ("media_entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_download_single_active" ON "youtube_downloads" ("video_id") WHERE "state" in ('queued','downloading','indexing');--> statement-breakpoint
ALTER TABLE "media_chapters" ADD CONSTRAINT "media_chapters_media_entry_id_media_entries_id_fkey" FOREIGN KEY ("media_entry_id") REFERENCES "media_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "youtube_downloads" ADD CONSTRAINT "youtube_downloads_media_entry_id_media_entries_id_fkey" FOREIGN KEY ("media_entry_id") REFERENCES "media_entries"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "media_roots" ADD CONSTRAINT "media_root_source" CHECK ("source" in ('folder','youtube'));--> statement-breakpoint
-- Zero replicates these columns; keep them in step with src/lib/zero/schema.ts (tests/db/migrations.test.ts checks this).
-- A published column list cannot be changed in place, so media_roots is published again with its new column.
ALTER PUBLICATION fern_data DROP TABLE media_roots;--> statement-breakpoint
ALTER PUBLICATION fern_data ADD TABLE
  media_roots (id, path, display_name, media_type, display_order, last_scanned_at, source),
  media_chapters (media_entry_id, position, start_ms, end_ms, title),
  youtube_downloads (id, video_id, url, state, title, channel, duration_ms, downloaded_bytes, total_bytes, media_entry_id, error_message, created_at, updated_at, completed_at);
