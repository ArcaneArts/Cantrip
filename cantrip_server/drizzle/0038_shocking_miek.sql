ALTER TABLE "project_worktrees" ADD COLUMN "status_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "project_worktrees" ADD COLUMN "status_observed_at" timestamp with time zone;