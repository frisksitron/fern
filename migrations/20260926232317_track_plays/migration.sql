CREATE TABLE "track_plays" (
	"id" uuid PRIMARY KEY,
	"profile_id" uuid NOT NULL,
	"media_entry_id" uuid NOT NULL,
	"played_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "track_play_recent" ON "track_plays" ("profile_id","played_at");--> statement-breakpoint
CREATE INDEX "track_play_profile_media" ON "track_plays" ("profile_id","media_entry_id");--> statement-breakpoint
CREATE INDEX "track_play_media" ON "track_plays" ("media_entry_id");--> statement-breakpoint
ALTER TABLE "track_plays" ADD CONSTRAINT "track_plays_profile_id_profiles_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "track_plays" ADD CONSTRAINT "track_plays_media_entry_id_media_entries_id_fkey" FOREIGN KEY ("media_entry_id") REFERENCES "media_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Zero replicates these columns; keep them in step with src/zero/schema.ts (tests/db/migrations.test.ts checks this).
ALTER PUBLICATION fern_data ADD TABLE track_plays (id, profile_id, media_entry_id, played_at);
