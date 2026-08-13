ALTER TABLE "explorers" ADD COLUMN "selected_path" text;--> statement-breakpoint
ALTER TABLE "explorers" ADD COLUMN "file_mode" text DEFAULT 'preview' NOT NULL;