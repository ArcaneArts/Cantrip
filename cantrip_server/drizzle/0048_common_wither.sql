ALTER TABLE "terminals" ADD COLUMN "service_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "terminals" ADD COLUMN "service_command" text DEFAULT '' NOT NULL;