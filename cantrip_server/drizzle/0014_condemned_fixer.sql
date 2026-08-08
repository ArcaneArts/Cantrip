ALTER TABLE "projects" ADD COLUMN "setup_status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "setup_error" text;