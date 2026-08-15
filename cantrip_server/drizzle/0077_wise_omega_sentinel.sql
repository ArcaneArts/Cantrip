ALTER TABLE "chats" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "chats_project_archived_index" ON "chats" USING btree ("project_id","archived_at");