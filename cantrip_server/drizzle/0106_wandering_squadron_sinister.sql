ALTER TABLE "chats" ADD COLUMN "protected_label" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" DROP COLUMN "title";