ALTER TABLE "chats" ADD COLUMN "protected_composer_draft" jsonb;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "composer_draft_updated_at" timestamp with time zone;