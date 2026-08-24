UPDATE "project_worktrees"
SET "lifecycle_state" = 'ready', "updated_at" = now()
WHERE "lifecycle_state" IN ('preparing', 'setup-failed', 'setup-stale');--> statement-breakpoint
UPDATE "terminals"
SET "status" = 'exited', "service_enabled" = false, "updated_at" = now()
WHERE "id" IN (
	SELECT "terminal_id" FROM "run_instances" WHERE "terminal_id" IS NOT NULL
);--> statement-breakpoint
DROP TABLE "run_instances" CASCADE;--> statement-breakpoint
DROP TABLE "worktree_setup_jobs" CASCADE;
