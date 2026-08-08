ALTER TABLE "chat_messages" ADD COLUMN "mode" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "queued_prompts" ADD COLUMN "mode" text DEFAULT 'default' NOT NULL;